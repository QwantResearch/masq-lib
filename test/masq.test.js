const signalserver = require('signalhubws/server')
const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const wrtc = require('wrtc')
const rai = require('random-access-idb')
const hyperdb = require('hyperdb')

const Masq = require('../src')

const HUB_URL = 'localhost:8080'

// user an in memory random-access-storage instead
jest.mock('random-access-idb', () =>
  () => require('random-access-memory'))

let server = null
let masq = null
let dbTest = null
let profile = {
  id: '123-4566-8789'
}
beforeAll(async () => {
  server = signalserver()
  server.listen(8080, () => console.log('server running'))
})

afterAll(async () => {
  server.close()
})

test('initialize', async () => {
  masq = new Masq()
  await masq.init()
})

// test('should get empty profiles', async () => {
//   let profiles = await masq.getProfiles()
//   expect(profiles).toEqual([])
// })

test('should generate a pairing link', () => {
  const uuidSize = 36
  const channel = '?channel='
  const challenge = '&challenge='
  const link = masq._getLink()
  expect(link.substring(0, channel.length)).toBe(channel)
  const offset = channel.length + uuidSize
  expect(link.substring(offset, offset + challenge.length)).toBe(challenge)
})

test('should join a channel', done => {
  expect.assertions(2)

  const uuidSize = 36
  const link = masq._getLink()
  const offset = '?channel='.length
  const channel = link.substring(offset, offset + uuidSize)
  expect(channel).toHaveLength(uuidSize)
  const hub = signalhub(channel, ['localhost:8080'])
  const sw = swarm(hub, { wrtc })

  sw.on('peer', (peer, id) => {
    expect(sw.peers).toHaveLength(1)
    sw.close()
    hub.close()
  })

  sw.on('close', () => {
    done()
  })

  masq.requestMasqAccess()
})

test('should be kicked if challenge does not match', async (done) => {
  expect.assertions(3)

  masq = new Masq()
  await masq.init()

  const uuidSize = 36
  const link = masq._getLink()
  const offset = '?channel='.length
  const channel = link.substring(offset, offset + uuidSize)
  expect(channel).toHaveLength(uuidSize)
  const hub = signalhub(channel, ['localhost:8080'])
  const sw = swarm(hub, { wrtc })

  sw.on('peer', (peer, id) => {
    expect(sw.peers).toHaveLength(1)
    peer.send(JSON.stringify({
      msg: 'sendProfilesKey',
      challenge: 'challengemismatch'
    }))
  })

  sw.on('disconnect', (peer, id) => {
    expect(peer).toBeDefined()
    sw.close()
  })

  sw.on('close', () => {
    done()
  })

  masq.requestMasqAccess()
})

test('should replicate masq-profiles', async (done) => {
  expect.assertions(1)
  masq = new Masq()
  await masq.init()

  const challenge = masq.challenge
  const channel = masq.channel

  /***
   * A link must be created (and sent to masq) containing :
   *  type: 'syncProfiles',
   *  channel: channel,
   *  challenge: challenge
   */
  const hub = signalhub(channel, [HUB_URL])
  const sw = swarm(hub, { wrtc })
  const key = 'c4b60362325d27ad3c04db158fa68fe6fde00387467708ab3a0be79c811b3825'

  sw.on('peer', (peer, id) => {
    peer.on('data', data => {
      const json = JSON.parse(data)

      expect(json.msg).toBe('replicationProfilesStarted')
      sw.close()
      hub.close()
    })

    peer.send(JSON.stringify({
      msg: 'sendProfilesKey',
      challenge: challenge,
      key: key
    }))
  })

  sw.on('close', () => {
    hub.close()
  })

  sw.on('disconnect', (peer, id) => {
    sw.close()
    hub.close()
    done()
  })

  masq.requestMasqAccess()
})

test('should fail to start key exchange when there is no profile selected', async () => {
  expect.assertions(1)
  try {
    masq.exchangeDataHyperdbKeys('app')
  } catch (e) {
    expect(e.message).toBe('No profile selected')
  }
})

test('should exchange key and authorize local key if challenge matches', async (done) => {
  expect.assertions(1)
  masq = new Masq()
  await masq.init()
  // We check which profile corresponds to the current user
  masq.setProfile(profile.id)

  const challenge = masq.challenge
  const channel = masq.channel
  const appName = 'app1'
  /***
   * A link must be created (and sent to masq) containing :
   *  type: 'syncData',
   *  channel: channel,
   *  challenge: challenge,
   *  appName: appName
   */

  const hub = signalhub(channel, [HUB_URL])
  const sw = swarm(hub, { wrtc })

  sw.on('peer', (peer, id) => {
    // create hyperdb for the requested service and send the key
    const key = 'c4b60362325d27ad3c04db158fa68fe6fde00387467708ab3a0be79c811b3825'

    peer.on('data', data => _handleData(data, peer))

    peer.send(JSON.stringify({
      msg: 'sendDataKey',
      challenge: challenge,
      key: key
    }))
  })

  sw.on('close', () => {
    hub.close()
    done()
  })

  sw.on('disconnect', (peer, id) => {
    sw.close()
    hub.close()
  })

  const _handleData = async (data, peer) => {
    const json = JSON.parse(data)
    switch (json.msg) {
      case 'requestWriteAccess':
        expect(json.key).toHaveLength(64)
        // authorize local key & start replication
        sw.close()
        hub.close()
        break
      default:
        break
    }
  }

  masq.exchangeDataHyperdbKeys(appName)
})

test('put should reject when there is no profile selected', async () => {
  expect.assertions(1)
  masq = new Masq()
  await masq.init()
  try {
    await masq.put('key', 'value')
  } catch (e) {
    expect(e.message).toBe('No profile selected')
  }
})

test('get should reject when there is no profile selected', async () => {
  expect.assertions(1)
  try {
    await masq.get('key')
  } catch (e) {
    expect(e.message).toBe('No profile selected')
  }
})

test('del should reject when there is no profile selected', async () => {
  expect.assertions(1)
  try {
    await masq.del('key')
  } catch (e) {
    expect(e.message).toBe('No profile selected')
  }
})

test('put/get should put and get an item', async () => {
  expect.assertions(1)
  const key = '/hello'
  const value = { data: 'world' }
  masq.setProfile(profile.id)
  dbTest = hyperdb(rai(profile.id), { valueEncoding: 'json' })
  // Only for test purpose, we overwrite the data hyperdb
  masq.dbs[profile.id] = dbTest
  await masq.put(key, value)
  const res = await masq.get('/hello')
  expect(res).toEqual(value)
})

test('del should del an item', async () => {
  expect.assertions(1)
  const key = '/hello'
  await masq.del(key)
  const res = await masq.get('/hello')
  expect(res).toBeUndefined()
})
