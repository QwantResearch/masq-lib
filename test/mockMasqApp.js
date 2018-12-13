const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const wrtc = require('wrtc')

const config = require('../config/config')
const utils = require('../src/utils')

class MockMasqApp {
  constructor () {
    this.dbs = {}
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
          sw.close()
          return reject(Error('Invalid Key'))
        }

        let registered = false

        sw.on('peer', async (peer, id) => {
          // Send authorize or not
          if (authorized) {
            peer.send(await utils.encryptMessage(key, {
              msg: 'authorized',
              userAppDbId: userAppId
            }))
          } else {
            peer.send(await utils.encryptMessage(key, {
              msg: 'notAuthorized'
            }))
          }

          peer.on('data', async data => {
            const json = await utils.decryptMessage(key, data)
            switch (json.msg) {
              case 'connectionEstablished':
                sw.close()
                break
              case 'registerUserApp':
                if (registered) {
                  reject(Error('Already registered but received message with type "registered"'))
                }
                if (registerAccepted) {
                  this.dbs[userAppId] = utils.createPromisifiedHyperDB(userAppId)
                  await utils.dbReady(this.dbs[userAppId])
                  peer.send(await utils.encryptMessage(key, {
                    msg: 'masqAccessGranted',
                    userAppDbId: userAppId,
                    key: this.dbs[userAppId].key.toString('hex')
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

                this.dbs[userAppId].authorizeAsync(Buffer.from(json.key, 'hex')).then(async () => {
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
