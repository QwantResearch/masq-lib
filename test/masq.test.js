const signalserver = require('signalhubws/server')
const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const wrtc = require('wrtc')
const rai = require('random-access-idb')
const hyperdb = require('hyperdb')

const Masq = require('../src')
const promiseHyperdb = require('../src/promiseHyperdb')
const MasqAppMock = require('./mockMasqApp')

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

afterAll((done) => {
  server.close(done)
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

  const masqAppMock = new MasqAppMock(HUB_URL)

  const { channel } = masq.requestMasqAccess()
  const wrongChallenge = 'wrongChallenge'
  // no await as this promise will never resolve because of wrong challenge
  masqAppMock.handleAccessRequest(channel, wrongChallenge)
  try {
    await masq.requestMasqAccessDone()
  } catch (err) {
    expect(err).toBeDefined()
    expect(err.message).toBe('Challenge does not match')
  }
  await masqAppMock.destroy()
})

test('should receive message replicationProfilesStarted', async () => {
  const masqAppMock = new MasqAppMock(HUB_URL)

  const { channel, challenge } = masq.requestMasqAccess()
  await masqAppMock.handleAccessRequest(channel, challenge)
  await masq.requestMasqAccessDone()
  await masqAppMock.destroy()
})

test('should fail to start key exchange when there is no profile selected', async () => {
  const masqAppMock = new MasqAppMock(HUB_URL)

  const { channel, challenge } = masq.requestMasqAccess()
  await masqAppMock.handleAccessRequest(channel, challenge)
  await masq.requestMasqAccessDone()
  expect.assertions(1)
  try {
    masq.exchangeDataHyperdbKeys('app')
  } catch (e) {
    await masq.exchangeDataHyperdbKeysDone()
    expect(e.message).toBe('No profile selected')
  }
  await masqAppMock.destroy()
})

test('should exchange key and authorize local key if challenge matches', async () => {
  const masqAppMock = new MasqAppMock(HUB_URL)

  const { channel, challenge } = masq.requestMasqAccess()
  await masqAppMock.handleAccessRequest(channel, challenge)
  await masq.requestMasqAccessDone()

  masq.setProfile(profile.id)

  const appInfo = {
    name: masq.appName,
    description: 'A wonderful app',
    image: ' a link to image'
  }

  const ret = masq.exchangeDataHyperdbKeys(appInfo)

  // We check which profile corresponds to the current user
  await masqAppMock.handleExchangeHyperdbKeys(ret.channel, ret.challenge, appInfo)
  await masq.exchangeDataHyperdbKeysDone()

  await masqAppMock.destroy()
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

test('watch should reject when there is no profile selected', async () => {
  expect.assertions(1)
  try {
    masq.watch('key', () => {})
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

test('should set a watcher', async (done) => {
  expect.assertions(1)
  const onChange = () => {
    expect(true).toBe(true)
    done()
  }
  _initTestDBForProfile()
  const key = '/hello'
  const value = { data: 'world' }
  masq.watch('/hello', onChange)
  await masq.put(key, value)
})
