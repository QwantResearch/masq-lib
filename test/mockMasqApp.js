const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const wrtc = require('wrtc')

const config = require('../config/config')

class MockMasqApp {
  constructor () {
    this.sws = {}
  }

  destroy () {
    const prArr = Object.values(this.sws).map(sw => {
      return new Promise((resolve, reject) => {
        sw.close(resolve)
      })
    })
    return Promise.all(prArr)
  }

  handleAccessRequest (channel, challenge) {
    return new Promise((resolve, reject) => {
      const hub = signalhub(channel, config.HUB_URLS)
      const sw = swarm(hub, { wrtc })
      this.sws[sw.me] = sw
      const key = 'c4b60362325d27ad3c04db158fa68fe6fde00387467708ab3a0be79c811b3825'

      sw.on('peer', (peer, id) => {
        peer.on('data', data => {
          const json = JSON.parse(data)
          if (json.msg !== 'replicationProfilesStarted') {
            reject(Error(`Expected to receive message with type "replicationProfilesStarted", but received "${json.msg}"`))
          }
          sw.close()
        })

        peer.send(JSON.stringify({
          msg: 'sendProfilesKey',
          challenge: challenge,
          key: key
        }))
      })

      sw.on('close', () => {
        delete this.sws[sw.me]
        resolve()
      })

      sw.on('disconnect', (peer, id) => {
      })
    })
  }

  handleExchangeHyperdbKeys (channel, challenge, appInfo) {
    return new Promise((resolve, reject) => {
      // simulating masq app
      const hub = signalhub(channel, config.HUB_URLS)
      const sw = swarm(hub, { wrtc })
      sw.on('peer', (peer, id) => {
        // create hyperdb for the requested service and send the key
        const key = 'c4b60362325d27ad3c04db158fa68fe6fde00387467708ab3a0be79c811b3825'

        peer.on('data', data => {
          const json = JSON.parse(data)
          switch (json.msg) {
            case 'appInfo':
              if (json.name !== appInfo.name) throw Error('Received wrong app name')
              if (json.description !== appInfo.description) throw Error('Received wrong app description')
              if (json.image !== appInfo.image) throw Error('Received wrong app image')
              peer.send(JSON.stringify({
                msg: 'sendDataKey',
                challenge: challenge,
                key: key
              }))
              break
            case 'requestWriteAccess':
              if (json.key.length !== 64) throw Error(`Received key with length ${json.key.length} instead of 64`)
              // authorize local key & start replication
              peer.send(JSON.stringify({
                msg: 'ready',
                challenge: challenge
              }))
              sw.close()
              break
            default:
              break
          }
        })
      })

      sw.on('close', () => {
        resolve()
      })

      sw.on('disconnect', (peer, id) => {
        sw.close()
      })

      sw.on('error', (err) => reject(err))
    })
  }
}

module.exports = MockMasqApp
