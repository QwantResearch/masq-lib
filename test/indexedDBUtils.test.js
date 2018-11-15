const indexedDBUtils = require('../src/indexedDBUtils')

window.indexedDB = require('fake-indexeddb')

test('DB should exist', async () => {
  window.indexedDB.open('test1')
  expect(await indexedDBUtils.dbExists('test1')).toBe(true)
})

test('DB should not exist', async () => {
  expect(await indexedDBUtils.dbExists('test2')).toBe(false)
})
