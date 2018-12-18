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
    const link = await masq.getLoginLink()
    // Display link to the user
    // and ask if he wants to stay connected on restart until he signs out
    const stayConnected = false
    // Once the link is opened, execute the following code
    await masq.logIntoMasq(stayConnected)

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
The data will then be synced between the different connected devices of the User.

#### `masq.signout() -> Promise<void>`

Signs out of Masq from Masq.
This also means the User-app data on the device will stop being synced.

### `masq.getLoginLink() -> Promise<link: string>`

The function returns a Promise resolving to an Url which must be opened by the user in order to connect to Masq.

#### `masq.logIntoMasq(stayConnected) -> Promise<void>`

`stayConnected` is a boolean representing if the User should stay connected until he explicitely signs out or only until he closes the User-app.

This function starts the login procedure with an instance of Masq-app
Once the user accesses the link and connects to his profile, the login will end and the returned promise will resolve.

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
