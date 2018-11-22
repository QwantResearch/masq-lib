const signalserver = require('signalhubws/server')
const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const wrtc = require('wrtc')
const rai = require('random-access-idb')
const hyperdb = require('hyperdb')

const Masq = require('../src')
const promiseHyperdb = require('../src/promiseHyperdb')

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

jest.setTimeout(30000)

beforeAll((done) => {
  server = signalserver()
  server.listen(8080, (err) => {
    if (err) throw err
    done()
  })
})

// FIXME afterAll should be async and we should provide done to server.close as callback
afterAll(() => {
  server.close()
})

beforeEach(async () => {
  masq = new Masq(APP_NAME)
  await masq.init()
})

afterEach(async () => {
  await masq.destroy()
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

test('someTest', async (done) => {
  setTimeout(() => {
    done()
  }, 2000)
  await new Promise((resolve) => {
    setTimeout(() => {
      resolve()
    }, 5000)
  })
})

test('should join a channel', async () => {
  expect.assertions(1)

  const pr = new Promise((resolve, reject) => {
    const { channel } = masq.requestMasqAccess()

    // simulating masq app
    const hub = signalhub(channel, [HUB_URL])
    const sw = swarm(hub, { wrtc })

    sw.on('peer', (peer, id) => {
      expect(sw.peers).toHaveLength(1)
      sw.close()
    })

    sw.on('close', () => {
      resolve()
    })
  })
  await pr
  await masq.requestMasqAccessDone()
})

test('should be kicked if challenge does not match', async () => {
  expect.assertions(2)

  const pr = new Promise((resolve, reject) => {
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
      resolve()
    })
  })

  await pr
  await masq.requestMasqAccessDone()
})

test('should receive message replicationProfilesStarted', async () => {
  expect.assertions(1)

  const pr = new Promise((resolve, reject) => {
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
      resolve()
    })

    sw.on('disconnect', (peer, id) => {
      sw.close()
    })
  })

  await pr
  await masq.requestMasqAccessDone()
})

async function _initProfilesReplication () {
  const pr = new Promise((resolve, reject) => {
    const { channel, challenge } = masq.requestMasqAccess()
    const key = 'c4b60362325d27ad3c04db158fa68fe6fde00387467708ab3a0be79c811b3825'

    // simulating masq app
    const hub = signalhub(channel, [HUB_URL])
    const sw = swarm(hub, { wrtc })
    sw.on('peer', (peer, id) => {
      peer.on('data', data => {
        const json = JSON.parse(data)
        if (json.msg === 'replicationProfilesStarted') {
          sw.close()
        }
      })

      peer.send(JSON.stringify({
        msg: 'sendProfilesKey',
        challenge: challenge,
        key: key
      }))
    })

    sw.on('close', () => {
      resolve()
    })

    sw.on('error', err => {
      reject(err)
    })
  })
  await pr
  await masq.requestMasqAccessDone()
}

test('should fail to start key exchange when there is no profile selected', async () => {
  expect.assertions(1)
  await _initProfilesReplication()
  try {
    masq.exchangeDataHyperdbKeys('app')
  } catch (e) {
    await masq.exchangeDataHyperdbKeysDone()
    expect(e.message).toBe('No profile selected')
  }
})

test('should exchange key and authorize local key if challenge matches', async () => {
  await _initProfilesReplication()
  expect.assertions(4)
  // We check which profile corresponds to the current user
  const pr = new Promise((resolve, reject) => {
    masq.setProfile(profile.id)

    const appInfo = {
      name: masq.app,
      description: 'A wonderful app',
      image: ' a link to image'
    }

    const { challenge, channel } = masq.exchangeDataHyperdbKeys(appInfo)

    // simulating masq app
    const hub = signalhub(channel, [HUB_URL])
    const sw = swarm(hub, { wrtc })
    sw.on('peer', (peer, id) => {
      // create hyperdb for the requested service and send the key
      const key = 'c4b60362325d27ad3c04db158fa68fe6fde00387467708ab3a0be79c811b3825'

      peer.on('data', data => {
        const json = JSON.parse(data)
        switch (json.msg) {
          case 'appInfo':
            expect(json.name).toBe(appInfo.name)
            expect(json.description).toBe(appInfo.description)
            expect(json.image).toBe(appInfo.image)
            peer.send(JSON.stringify({
              msg: 'sendDataKey',
              challenge: challenge,
              key: key
            }))
            break
          case 'requestWriteAccess':
            expect(json.key).toHaveLength(64)
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

  await pr
  await masq.exchangeDataHyperdbKeysDone()
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

test('should get one profile', async () => {
  const profile = { username: 'someusername' }
  const dbTest = hyperdb(rai('dbtest'), { valueEncoding: 'json' })
  masq.dbs.profiles = dbTest
  await promiseHyperdb.put(dbTest, '/profiles', ['id'])
  await promiseHyperdb.put(dbTest, '/profiles/id', profile)
  let profiles = await masq.getProfiles()
  expect(profiles).toHaveLength(1)
  expect(profiles[0]).toEqual(profile)
})
