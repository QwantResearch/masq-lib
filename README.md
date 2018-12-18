# masq-lib

## Install
```
npm install masq-lib --save
```

## Launch Test
```
npm install
npm test
```

## Analyze bundle size with:
```
npm run stats
npm run analyze
```


## Usage

``` js
const Masq = require('masq-lib')

const masq = new Masq(
    'TestApp',
    'Some User-app',
    'http://www.some-user-app.com/logo.png'
)

if (masq.isLoggedIn()) {
    await masq.connectToMasq()
} else {
    const stayConnected = false
    const { link } = await masq.logIntoMasq(stayConnected)
    // Display link to the user
    await masq.logIntoMasqDone()

    await masq.put('someKey', 'someValue')
    const val = await masq.get('someKey')
}
```

## API

#### `const masq = new Masq(appName, appDescription, appLogoURL)`

Create a new instance of Masq.

`appName` is the name of the app.

`appDescription` is a short description of the app.

`appLogoURL` is a link to a logo of the app.


#### `masq.isLoggedIn() : boolean`

Returns a boolean, true if a User is already logged into Masq, false if not.
The User can read and write data stored in his Masq only if he is logged in.
This does not necessarily mean the data is synced, masq.isConnected() needs to be true for data to be synced between the different connected devices.

#### `masq.isConnected() -> connected: boolean`

Returns a boolean, true if a User is already logged into Masq and if the User-app is already connected to Masq.
The User data is synced between the different connected devices only when the User is connected.

#### `masq.connectToMasq() -> Promise<void>`

Connects to Masq if a User is already logged into Masq.
The data will then be synced between the different connected devices of the User

#### `masq.signout() -> Promise<void>`

Signs out of Masq from Masq.
This also means the User-app data on the device will stop being synced.

#### `masq.logIntoMasq(stayConnected) -> Promise<ret: object>`

`stayConnected` is a boolean representing if the User should stay connected until he explicitely signs out.

The function returns an object containing an attribute `link` containing the Url the user has to access to connect to Masq.

Starts the login procedure with Masq and returns a link.
Once the user access the link and connects to his profile, the login will end, this can be checked with the `masq.logIntoMasqDone()`.

#### `masq.logIntoMasqDone() -> Promise<void>`

Returns a promise that resolves when the login procedure ends.

#### `masq.get(key) -> Promise<string>`

Returns a promise resolving with the value stored for the provided `key`.

#### `masq.put(key, value) -> Promise<void>`

Returns a promise resolving when the `key`/`value` pair is stored.

#### `masq.del(key) -> Promise<void>`

Returns a promise resolving when the key/value pais is deleted for the specified `key`.

#### `masq.watch(key, callback) -> void`

Adds the event handler `callback` called when the key/value pair for the specified `key` is updated.

#### `masq.list(prefix) -> Promise<keyValues: object>`

Returns a Promise resolving with an object containing each key/value pairs as attribute/value pairs.
