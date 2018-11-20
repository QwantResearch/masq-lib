const signalserver = require('signalhubws/server')
const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const wrtc = require('wrtc')
const rai = require('random-access-idb')
const hyperdb = require('hyperdb')

const Masq = require('../src')

const HUB_URL = 'localhost:8080'
const APP_NAME = 'app1'

// user an in memory random-access-storage instead
jest.mock('random-access-idb', () =>
  () => require('random-access-memory'))

jest.mock('../src/promiseHyperdb', () => {
  const original = require.requireActual('../src/promiseHyperdb')
  return {
    ...original,
    dbExists: jest.fn(() => false)
  }
})

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

beforeEach(async () => {
  masq = new Masq(APP_NAME)
  await masq.init()
})

test('should generate a pairing link', () => {
  const uuidSize = 36
  const { link, channel, challenge } = masq.requestMasqAccess()
  const url = new URL(link)
  expect(url.searchParams.get('channel')).toHaveLength(uuidSize)
  expect(url.searchParams.get('channel')).toBe(channel)
  expect(url.searchParams.get('challenge')).toHaveLength(uuidSize)
  expect(url.searchParams.get('challenge')).toBe(challenge)
})

test('should join a channel', done => {
  expect.assertions(1)

  const { channel } = masq.requestMasqAccess()

  // simulating masq app
  const hub = signalhub(channel, [HUB_URL])
  const sw = swarm(hub, { wrtc })

  sw.on('peer', (peer, id) => {
    expect(sw.peers).toHaveLength(1)
    sw.close()
  })

  sw.on('close', () => {
    done()
  })
})

test('should be kicked if challenge does not match', done => {
  expect.assertions(2)

  const { channel } = masq.requestMasqAccess()

  // simulating masq app
  const hub = signalhub(channel, [HUB_URL])
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
})

test('should receive message replicationProfilesStarted', async (done) => {
  expect.assertions(1)

  const { channel, challenge } = masq.requestMasqAccess()
  const key = 'c4b60362325d27ad3c04db158fa68fe6fde00387467708ab3a0be79c811b3825'

  // simulating masq app
  const hub = signalhub(channel, [HUB_URL])
  const sw = swarm(hub, { wrtc })

  sw.on('peer', (peer, id) => {
    peer.on('data', data => {
      const json = JSON.parse(data)
      expect(json.msg).toBe('replicationProfilesStarted')
      sw.close()
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
    done()
  })
})

function _initProfilesReplication () {
  const { channel, challenge } = masq.requestMasqAccess()
  const key = 'c4b60362325d27ad3c04db158fa68fe6fde00387467708ab3a0be79c811b3825'

  // simulating masq app
  const hub = signalhub(channel, [HUB_URL])
  const sw = swarm(hub, { wrtc })
  sw.on('peer', (peer, id) => {
    peer.on('data', data => {
      sw.close()
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
  })
}

test('should fail to start key exchange when there is no profile selected', async () => {
  _initProfilesReplication()
  expect.assertions(1)
  try {
    masq.exchangeDataHyperdbKeys('app')
  } catch (e) {
    expect(e.message).toBe('No profile selected')
  }
})

test('should exchange key and authorize local key if challenge matches', async (done) => {
  _initProfilesReplication()
  expect.assertions(1)
  // We check which profile corresponds to the current user
  masq.setProfile(profile.id)

  const { challenge, channel } = masq.exchangeDataHyperdbKeys()

  // simulating masq app
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
  })

  const _handleData = async (data, peer) => {
    const json = JSON.parse(data)
    switch (json.msg) {
      case 'requestWriteAccess':
        expect(json.key).toHaveLength(64)
        // authorize local key & start replication
        sw.close()
        break
      default:
        break
    }
  }
})

test('put should reject when there is no profile selected', async () => {
  expect.assertions(1)
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

function _initTestDBForProfile () {
  masq.setProfile(profile.id)
  // Only for test purpose, we overwrite the data hyperdb
  dbTest = hyperdb(rai(profile.id), { valueEncoding: 'json' })
  masq.dbs[profile.id] = dbTest
}

test('put/get should put and get an item', async () => {
  expect.assertions(1)
  _initTestDBForProfile()
  const key = '/hello'
  const value = { data: 'world' }
  await masq.put(key, value)
  const res = await masq.get('/hello')
  expect(res).toEqual(value)
})

test('del should del an item', async () => {
  expect.assertions(1)
  _initTestDBForProfile()
  const key = '/hello'
  const value = { data: 'world' }
  await masq.put(key, value)
  await masq.del(key)
  const res = await masq.get('/hello')
  expect(res).toBeNull()
})

test('should get empty profiles', async () => {
  dbTest = hyperdb(rai('masq-profiles'), { valueEncoding: 'json' })
  masq.dbs.profiles = dbTest
  let profiles = await masq.getProfiles()
  expect(profiles).toEqual([])
})

test('should get one profile', async (done) => {
  const profile = { username: 'someusername' }
  const dbTest = hyperdb(rai('dbtest'), { valueEncoding: 'json' })
  masq.dbs.profiles = dbTest
  dbTest.put('/profiles', ['id'], () => {
    dbTest.put('profiles/id', profile, async () => {
      let profiles = await masq.getProfiles()
      expect(profiles).toHaveLength(1)
      expect(profiles[0]).toEqual(profile)
      done()
    })
  })
})
