# Cadence

Quiet rooms, loud ideas — a real-time chat app with rooms, roles, media uploads, and an admin panel.

## Features

- Real-time messaging (Socket.IO)
- Public, private, and locked rooms
- Discord-style per-room roles and permissions
- File, image, audio, emoji, and GIF attachments
- Screen recording with preview
- Activity logs and themed image lightbox
- Super-admin panel (users, rooms, storage, settings)

## Quick start

```bash
npm install
cp .env.example .env
npm start
```

Open [http://localhost:3000](http://localhost:3000).

Configure super admins in `.env`:

```
SUPER_ADMIN_USERNAMES=you@example.com
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run the server |
| `npm run dev` | Run with file watch |
| `npm test` | Smoke tests |

## Stack

Node.js, Socket.IO, Busboy — static frontend with Motion One animations.

## License

MIT
