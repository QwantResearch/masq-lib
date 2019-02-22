const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const wrtc = require('wrtc')
const uuidv4 = require('uuid/v4')
const pump = require('pump')
const common = require('masq-common')
const ERRORS = common.errors.ERRORS
const MasqError = common.errors.MasqError

const config = require('../config/config.test.json')

class MockMasqApp {
  constructor () {
    this.dbs = {}
    this.dbsRepHub = {}
    this.dbsRepSW = {}
    this.userAppDEK = '00112233445566778899AABBCCDDEEFF'
    this.dataEncryptionKey = null
    this.profileImage = 'image'
    this.username = 'bob'
  }

  async init () {
    this.dataEncryptionKey = await common.crypto.importKey(Buffer.from(this.userAppDEK, 'hex'))
  }

  destroy () {
    Object.values(this.dbsRepSW).forEach(sw => {
      sw.close()
    })
  }

  _startReplication (userAppId) {
    const discoveryKey = this.dbs[userAppId].discoveryKey.toString('hex')
    this.dbsRepHub[userAppId] = signalhub(discoveryKey, config.hubUrls)

    if (swarm.WEBRTC_SUPPORT) {
      this.dbsRepSW[userAppId] = swarm(this.dbsRepHub[userAppId])
    } else {
      this.dbsRepSW[userAppId] = swarm(this.dbsRepHub[userAppId], { wrtc: require('wrtc') })
    }

    this.dbsRepSW[userAppId].on('peer', async (peer, id) => {
      const stream = this.dbs[userAppId].replicate({ live: true })
      pump(peer, stream, peer)
    })
  }

  async _decryptValue (ciphertext) {
    let decryptedMsg = await common.crypto.decrypt(this.dataEncryptionKey, ciphertext)
    return decryptedMsg
  }

  async _encryptValue (plaintext) {
    let encryptedMsg = await common.crypto.encrypt(this.dataEncryptionKey, plaintext)
    return encryptedMsg
  }

  async get (userAppId, key) {
    const node = await this.dbs[userAppId].getAsync(key)
    if (!node) return null
    const dec = await this._decryptValue(node.value)
    return dec
    // return node.value
  }

  async put (userAppId, key, value) {
    const enc = await this._encryptValue(value)
    return this.dbs[userAppId].putAsync(key, enc)
  }

  watch (userAppId, key, cb) {
    return this.dbs[userAppId].watch(key, () => cb())
  }

  handleConnectionAuthorized (channel, key) {
    return this._handleConnection(true, true)(channel, key)
  }

  handleConnectionNotAuthorized (channel, key) {
    return this._handleConnection(false, true)(channel, key)
  }

  handleConnectionRegisterRefused (channel, challenge) {
    return this._handleConnection(false, false)(channel, challenge)
  }

  _handleConnection (authorized, registerAccepted) {
    return (channel, rawKey) => {
      return new Promise(async (resolve, reject) => {
        const hub = signalhub(channel, config.hubUrls)
        const sw = swarm(hub, { wrtc })
        const userAppId = 'userAppId-' + uuidv4()

        let key
        try {
          key = await common.crypto.importKey(rawKey)
        } catch (err) {
          sw.close()
          return reject(new MasqError(ERRORS.INVALID_KEY))
        }

        let registered = false

        sw.on('peer', async (peer, id) => {
          // Send authorize or not
          if (authorized) {
            const msg = {
              msg: 'authorized',
              userAppDbId: userAppId,
              userAppDEK: this.userAppDEK,
              profileImage: this.profileImage,
              username: this.username
            }
            const encryptedMsg = await common.crypto.encrypt(key, msg, 'base64')
            peer.send(JSON.stringify(encryptedMsg))
          } else {
            const msg = {
              msg: 'notAuthorized'
            }
            const encryptedMsg = await common.crypto.encrypt(key, msg, 'base64')
            peer.send(JSON.stringify(encryptedMsg))
          }

          peer.on('data', async data => {
            const json = await common.crypto.decrypt(key, JSON.parse(data), 'base64')
            switch (json.msg) {
              case 'connectionEstablished':
                sw.close()
                break
              case 'registerUserApp':
                if (registered) {
                  reject(new MasqError(ERRORS.WRONG_MESSAGE, 'Already registered but received message with type "registered"'))
                }
                if (registerAccepted) {
                  this.dbs[userAppId] = common.utils.createPromisifiedHyperDB(userAppId)
                  await common.utils.dbReady(this.dbs[userAppId])
                  this._startReplication(userAppId)
                  const msg = {
                    msg: 'masqAccessGranted',
                    userAppDbId: userAppId,
                    userAppDEK: this.userAppDEK,
                    key: this.dbs[userAppId].key.toString('hex'),
                    profileImage: this.profileImage,
                    username: this.username
                  }
                  const encryptedMsg = await common.crypto.encrypt(key, msg, 'base64')
                  peer.send(JSON.stringify(encryptedMsg))
                  registered = true
                } else {
                  const msg = {
                    msg: 'masqAccessRefused'
                  }
                  const encryptedMsg = await common.crypto.encrypt(key, msg, 'base64')
                  peer.send(JSON.stringify(encryptedMsg))
                  sw.close()
                }
                break
              case 'requestWriteAccess':
                if (!registered) {
                  reject(new MasqError(ERRORS.WRONG_MESSAGE, 'Expected to receive message with type "register", but received "requestWriteAccess"'))
                }

                this.dbs[userAppId].authorizeAsync(Buffer.from(json.key, 'hex')).then(async () => {
                  const msg = {
                    msg: 'writeAccessGranted'
                  }
                  const encryptedMsg = await common.crypto.encrypt(key, msg, 'base64')
                  peer.send(JSON.stringify(encryptedMsg))
                  sw.close()
                })

                break
              default:
                reject(new MasqError(ERRORS.WRONG_MESSAGE, `Expected to receive message with type "register" or "requestWriteAccess", but received "${json.msg}"`))
                sw.close()
                break
            }
          })
        })

        sw.on('close', () => {
          resolve()
        })

        sw.on('disconnect', (peer, id) => {
        })
      })
    }
  }
}

module.exports = MockMasqApp
