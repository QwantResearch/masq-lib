const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const wrtc = require('wrtc')

const config = require('../config/config')
const utils = require('../src/utils')

class MockMasqApp {
  constructor () {
    this.db = null
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
        const userAppId = 'userAppId'

        let key
        try {
          key = await window.crypto.subtle.importKey(
            'raw',
            rawKey,
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
          )
        } catch (err) {
          return reject(Error('Invalid Key'))
        }

        let registered = false

        sw.on('peer', async (peer, id) => {
          // Send authorize or not
          if (authorized) {
            peer.send(await utils.encryptMessage(key, {
              msg: 'authorized',
              userId: userAppId
            }))
          } else {
            peer.send(await utils.encryptMessage(key, {
              msg: 'notAuthorized'
            }))
          }

          peer.on('data', async data => {
            const json = await utils.decryptMessage(key, data)
            switch (json.msg) {
              case 'registerUserApp':
                if (registered) {
                  reject(Error('Already registered but received message with type "registered"'))
                }
                if (registerAccepted) {
                  this.db = utils.createPromisifiedHyperDB(userAppId)
                  await utils.dbReady(this.db)
                  peer.send(await utils.encryptMessage(key, {
                    msg: 'masqAccessGranted',
                    userId: userAppId,
                    key: this.db.discoveryKey.toString('hex')
                  }))
                  registered = true
                } else {
                  peer.send(await utils.encryptMessage(key, {
                    msg: 'masqAccessRefused'
                  }))
                  sw.close()
                }
                break
              case 'requestWriteAccess':
                if (!registered) {
                  reject(Error('Expected to receive message with type "register", but received "requestWriteAccess"'))
                }

                this.db.authorizeAsync(Buffer.from(json.key, 'hex')).then(async () => {
                  peer.send(await utils.encryptMessage(key, {
                    msg: 'writeAccessGranted'
                  }))
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
