const signalserver = require('signalhubws/server')
const signalhub = require('signalhubws')
const swarm = require('webrtc-swarm')
const wrtc = require('wrtc')

const Masq = require('../src/index')

// user an in memory random-access-storage instead
jest.mock('random-access-idb', () =>
  () => require('random-access-memory'))

let server = null
let masq = null

beforeAll(() => {
  server = signalserver()
  server.listen(8080, () => console.log('server running'))
})

afterAll(() => {
  server.close()
})

test('initialize', async () => {
  masq = new Masq()
  await masq.init()
})

test('should get empty profiles', async () => {
  let profiles = await masq.getProfiles()
  expect(profiles).toEqual([])
})

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
      msg: 'challenge',
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
