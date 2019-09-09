const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const uuidv4 = require('uuid/v4')
const pump = require('pump')
const common = require('masq-common')
const { promisify } = require('es6-promisify')
const hyperdb = require('hyperdb')
const ram = require('random-access-memory')

const config = require('../config/config.test.json')

const MasqError = common.errors.MasqError
const MasqMessages = common.messages.UserAppLogin

const createPromisifiedHyperDBMock = (name, hexKey) => {
  const methodsToPromisify = ['version', 'put', 'get', 'del', 'batch', 'list', 'authorize', 'authorized']
  const keyBuffer = hexKey
    ? Buffer.from(hexKey, 'hex')
    : null

  const db = hyperdb(ram, keyBuffer, { valueEncoding: 'json', firstNode: true })

  // Promisify methods with Async suffix
  methodsToPromisify.forEach(m => {
    db[`${m}Async`] = promisify(db[m])
  })

  return db
}

class MockMasqApp {
  constructor () {
    this.dbs = {}
    this.dbsRepHub = {}
    this.dbsRepSW = {}
    this.userAppDEK = '00112233445566778899AABBCCDDEEFF'
    this.dataEncryptionKey = null
    this.nonce = '00112233445566778899AABBCCDDEEFF'
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

    this.dbsRepSW[userAppId] = swarm(this.dbsRepHub[userAppId])

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
    const hashedKey = await common.utils.hashKey(key, this.nonce)
    const node = await this.dbs[userAppId].getAsync(hashedKey)
    if (!node) return null
    const dec = await this._decryptValue(node.value)
    return dec
    // return node.value
  }

  async put (userAppId, key, value) {
    const enc = await this._encryptValue(value)
    const hashedKey = await common.utils.hashKey(key, this.nonce)
    return this.dbs[userAppId].putAsync(hashedKey, enc)
  }

  async watch (userAppId, key, cb) {
    const hashedKey = await common.utils.hashKey(key, this.nonce)
    return this.dbs[userAppId].watch(hashedKey, () => cb())
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
        const sw = swarm(hub)
        const userAppId = 'userAppId-' + uuidv4()

        let key
        try {
          key = await common.crypto.importKey(rawKey)
        } catch (err) {
          sw.close()
          return reject(new MasqError(MasqError.INVALID_KEY))
        }

        let registered = false

        sw.on('peer', async (peer, id) => {
          // Send authorize or not
          if (authorized) {
            const msg = {
              msg: MasqMessages.AUTHORIZED,
              userAppDbId: userAppId,
              userAppDEK: this.userAppDEK,
              userAppNonce: this.nonce,
              profileImage: this.profileImage,
              username: this.username
            }
            const encryptedMsg = await common.crypto.encrypt(key, msg, 'base64')
            peer.send(JSON.stringify(encryptedMsg))
          } else {
            const msg = {
              msg: MasqMessages.NOT_AUTHORIZED
            }
            const encryptedMsg = await common.crypto.encrypt(key, msg, 'base64')
            peer.send(JSON.stringify(encryptedMsg))
          }

          peer.on('data', async data => {
            const json = await common.crypto.decrypt(key, JSON.parse(data), 'base64')
            switch (json.msg) {
              case MasqMessages.CONNECTION_ESTABLISHED:
                sw.close()
                break
              case MasqMessages.REGISTER_USER_APP:
                if (registered) {
                  reject(new MasqError(MasqError.WRONG_MESSAGE, 'Already registered but received message with type "registered"'))
                }
                if (registerAccepted) {
                  this.dbs[userAppId] = createPromisifiedHyperDBMock(userAppId)
                  await common.utils.dbReady(this.dbs[userAppId])
                  this._startReplication(userAppId)
                  const msg = {
                    msg: MasqMessages.MASQ_ACCESS_GRANTED,
                    userAppDbId: userAppId,
                    userAppDEK: this.userAppDEK,
                    userAppNonce: this.nonce,
                    key: this.dbs[userAppId].key.toString('hex'),
                    profileImage: this.profileImage,
                    username: this.username
                  }
                  const encryptedMsg = await common.crypto.encrypt(key, msg, 'base64')
                  peer.send(JSON.stringify(encryptedMsg))
                  registered = true
                } else {
                  const msg = {
                    msg: MasqMessages.MASQ_ACCESS_REFUSED
                  }
                  const encryptedMsg = await common.crypto.encrypt(key, msg, 'base64')
                  peer.send(JSON.stringify(encryptedMsg))
                  sw.close()
                }
                break
              case MasqMessages.REQUEST_WRITE_ACCESS:
                if (!registered) {
                  reject(new MasqError(MasqError.WRONG_MESSAGE, 'Expected to receive message with type "register", but received "requestWriteAccess"'))
                }

                this.dbs[userAppId].authorizeAsync(Buffer.from(json.key, 'hex')).then(async () => {
                  const msg = {
                    msg: MasqMessages.WRITE_ACCESS_GRANTED
                  }
                  const encryptedMsg = await common.crypto.encrypt(key, msg, 'base64')
                  peer.send(JSON.stringify(encryptedMsg))
                  sw.close()
                })

                break
              default:
                reject(new MasqError(MasqError.WRONG_MESSAGE, `Expected to receive message with type "register" or "requestWriteAccess", but received "${json.msg}"`))
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
