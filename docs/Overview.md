# Masq lib

Developers will use masq-lib to

- manage users (signin, signout)
- sync and securely store data

## Databases architecture

- masq-core: In this DB, masq will store users' preferences for instance. It should stay private between masq app instances, hence, it is never exposed to web apps.
- masq-profiles: Contains users public info (id, username, avatar)
- all apps databases. One DB per user, per app.

### masq-core

- `/users` -> list of users ids
- `/users/:id/profile` -> private profile (username, avatar, lastname, firstname)
- `/users/:id/apps` -> list of apps ids
- `/users/:id/apps/:appid/info` -> name, color, logo etc ...
- `/users/:id/devices` -> list of apps ids
- [...]

### masq-profiles

- `/users` -> list of users ids
- `/users/:id/profile` -> public profile (username, avatar)

### App db

The app DB will be used freely by the app developer. We encapsulate the `put/get/del` methods exposed by hyperdb, as Promises. So the developer should refer to the hyperdb's doc for an in-depth explanation: https://github.com/mafintosh/hyperdb/blob/master/ARCHITECTURE.md.

## How it works

1) User need to register a new profile inside Masq. (at masq.qwant.com for instance). Masq will create and sync multiple DBs.

2) The user go to a compatible app. As it is the first time he opens this app, the app will provide a unique and secure link to sync `masq-profiles` db ((read-only). Once the user clicks on the link, the app will exchange messages through webrtc with masq to sync the db.

3) The app is now able to list the available users. The user can now try to signin with its username/password. As it is the first time, masq-lib will redirect the user to masq to authorize the new app. If the user authorizes the app, a new Database will be created specifically for this couple of user-app, and write-access will be given to the app.

4) DBs are now synchronizing. From now, every time the app is opened, masq-lib will open the databases, and replicate them.
