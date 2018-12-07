const signalserver = require('signalhubws/server')
const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const wrtc = require('wrtc')
window.crypto = require('@trust/webcrypto')

const Masq = require('../src')
const MasqAppMock = require('./mockMasqApp')
const config = require('../config/config')

const APP_NAME = 'app1'
const APP_DESCRIPTION = 'A wonderful app'
const APP_IMAGE_URL = ' a link to image'

// user an in memory random-access-storage instead
jest.mock('random-access-idb', () =>
  () => require('random-access-memory'))

jest.mock('../src/utils', () => {
  const original = require.requireActual('../src/utils')
  return {
    ...original,
    dbExists: jest.fn(() => false)
  }
})

let server = null
let masq = null

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

beforeEach(() => {
  masq = new Masq(APP_NAME, APP_DESCRIPTION, APP_IMAGE_URL)
})

afterEach(async () => {
  await masq.destroy()
})

test('should generate a pairing link', async () => {
  const uuidSize = 36
  const { link, channel } = await masq.connectToMasq()
  const url = new URL(link)
  let base = config.MASQ_APP_BASE_URL
  expect(url.origin + url.pathname).toBe(base)
  expect(url.searchParams.get('channel')).toHaveLength(uuidSize)
  expect(url.searchParams.get('channel')).toBe(channel)
})

test('should join a channel', async () => {
  expect.assertions(1)

  const pr = new Promise(async (resolve, reject) => {
    const { channel } = await masq.connectToMasq()

    // simulating masq app
    const hub = signalhub(channel, config.HUB_URLS)
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
  await masq.connectToMasqDone()
})

test('should be kicked if key is invalid', async () => {
  expect.assertions(2)

  const masqAppMock = new MasqAppMock()

  const { channel } = await masq.connectToMasq()
  const wrongRawKey = 'wrongChallenge'
  try {
    await Promise.all([
      masqAppMock.handleConnectionAuthorized(channel, wrongRawKey),
      masq.connectToMasqDone()
    ])
  } catch (err) {
    expect(err).toBeDefined()
    expect(err.message).toBe('Invalid Key')
  }
})

test('should connect to Masq with key passed through url param', async () => {
  const masqAppMock = new MasqAppMock()

  const { channel, link } = await masq.connectToMasq()
  const url = new URL(link)
  const rawKey = Buffer.from(url.searchParams.get('key'), 'base64')

  await Promise.all([
    masqAppMock.handleConnectionAuthorized(channel, rawKey),
    masq.connectToMasqDone()
  ])
})

test('should fail when register is refused', async () => {
  const masqAppMock = new MasqAppMock()

  const { channel, link } = await masq.connectToMasq()
  const url = new URL(link)
  const rawKey = Buffer.from(url.searchParams.get('key'), 'base64')
  await masqAppMock.handleConnectionRegisterRefused(channel, rawKey)
  expect.assertions(1)
  try {
    await masq.connectToMasqDone()
  } catch (e) {
    expect(e.message).toBe('Masq access refused by the user')
  }
})

// TODO tests for unexpected message received

async function _initMasqDB () {
  const masqAppMock = new MasqAppMock()
  const { channel, link } = await masq.connectToMasq()
  const url = new URL(link)
  const rawKey = Buffer.from(url.searchParams.get('key'), 'base64')
  await masqAppMock.handleConnectionAuthorized(channel, rawKey)
  await masq.connectToMasqDone()
}

test('put/get should put and get an item', async () => {
  expect.assertions(1)
  await _initMasqDB()
  const key = '/hello'
  const value = { data: 'world' }
  await masq.put(key, value)
  const res = await masq.get('/hello')
  expect(res).toEqual(value)
})

test('del should del an item', async () => {
  expect.assertions(1)
  await _initMasqDB()
  const key = '/hello'
  const value = { data: 'world' }
  await masq.put(key, value)
  await masq.del(key)
  const res = await masq.get('/hello')
  expect(res).toBeUndefined()
})

test('should set a watcher', async (done) => {
  expect.assertions(1)
  const onChange = () => {
    expect(true).toBe(true)
    done()
  }
  await _initMasqDB()
  const key = '/hello'
  const value = { data: 'world' }
  masq.watch('/hello', onChange)
  await masq.put(key, value)
})
