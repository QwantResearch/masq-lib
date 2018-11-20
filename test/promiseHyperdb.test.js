const promiseHyperdb = require('../src/promiseHyperdb')

window.indexedDB = require('fake-indexeddb')

test('DB should exist', async () => {
  window.indexedDB.open('test1')
  expect(await promiseHyperdb.dbExists('test1')).toBe(true)
})

test('DB should not exist', async () => {
  expect(await promiseHyperdb.dbExists('test2')).toBe(false)
})
