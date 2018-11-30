const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const wrtc = require('wrtc')

const config = require('../config/config')
const utils = require('../src/utils')

class MockMasqApp {
  handleConnectionAuthorized (channel, challenge) {
    return this._handleConnection(true, true)(channel, challenge)
  }

  handleConnectionNotAuthorized (channel, challenge) {
    return this._handleConnection(false, true)(channel, challenge)
  }

  handleConnectionRegisterRefused (channel, challenge) {
    return this._handleConnection(false, false)(channel, challenge)
  }

  _handleConnection (authorized, registerAccepted) {
    return (channel, challenge) => {
      return new Promise((resolve, reject) => {
        const hub = signalhub(channel, config.HUB_URLS)
        const sw = swarm(hub, { wrtc })
        const userAppId = 'userAppId'
        let db

        let registered = false

        sw.on('peer', (peer, id) => {
          // Send authorize or not
          if (authorized) {
            peer.send(JSON.stringify({
              msg: 'authorized',
              challenge: challenge,
              id: userAppId
            }))
          } else {
            peer.send(JSON.stringify({
              msg: 'notAuthorized',
              challenge: challenge
            }))
          }

          peer.on('data', data => {
            const json = JSON.parse(data)
            switch (json.msg) {
              case 'registerUserApp':
                if (registered) {
                  reject(Error('Already registered but received message with type "registered"'))
                }
                if (registerAccepted) {
                  db = utils.createPromisifiedHyperDB(userAppId)
                  utils.dbReady(db).then(() => {
                    peer.send(JSON.stringify({
                      msg: 'masqAccessGranted',
                      challenge: challenge,
                      id: userAppId,
                      key: db.discoveryKey.toString('hex')
                    }))
                    registered = true
                  })
                } else {
                  peer.send(JSON.stringify({
                    msg: 'masqAccessRefused',
                    challenge: challenge
                  }))
                  sw.close()
                }
                break
              case 'requestWriteAccess':
                if (!registered) {
                  reject(Error('Expected to receive message with type "register", but received "requestWriteAccess"'))
                }

                db.authorizeAsync(Buffer.from(json.key, 'hex')).then(() => {
                  peer.send(JSON.stringify({
                    msg: 'writeAccessGranted',
                    challenge: challenge
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
