const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const wrtc = require('wrtc')
const uuidv4 = require('uuid/v4')
const pump = require('pump')
const common = require('masq-common/dist')

const config = require('../config/config')

class MockMasqApp {
  constructor () {
    this.dbs = {}
    this.dbsRepHub = {}
    this.dbsRepSW = {}
  }

  destroy () {
    Object.values(this.dbsRepSW).forEach(sw => {
      sw.close()
    })
  }

  _startReplication (userAppId) {
    const discoveryKey = this.dbs[userAppId].discoveryKey.toString('hex')
    this.dbsRepHub[userAppId] = signalhub(discoveryKey, config.HUB_URLS)

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

  async get (userAppId, key) {
    const nodes = await this.dbs[userAppId].getAsync(key)
    if (!nodes.length) return nodes[0]
    return nodes[0].value
  }

  async put (userAppId, key, value) {
    return this.dbs[userAppId].putAsync(key, value)
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
        const hub = signalhub(channel, config.HUB_URLS)
        const sw = swarm(hub, { wrtc })
        const userAppId = 'userAppId-' + uuidv4()

        let key
        try {
          key = await common.crypto.importKey(rawKey)
        } catch (err) {
          sw.close()
          return reject(Error('Invalid Key'))
        }

        let registered = false

        sw.on('peer', async (peer, id) => {
          // Send authorize or not
          if (authorized) {
            const msg = {
              msg: 'authorized',
              userAppDbId: userAppId
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
                  reject(Error('Already registered but received message with type "registered"'))
                }
                if (registerAccepted) {
                  this.dbs[userAppId] = common.utils.createPromisifiedHyperDB(userAppId)
                  await common.utils.dbReady(this.dbs[userAppId])
                  this._startReplication(userAppId)
                  const msg = {
                    msg: 'masqAccessGranted',
                    userAppDbId: userAppId,
                    key: this.dbs[userAppId].key.toString('hex')
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
                  reject(Error('Expected to receive message with type "register", but received "requestWriteAccess"'))
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
                reject(Error(`Expected to receive message with type "register" or "requestWriteAccess", but received "${json.msg}"`))
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
