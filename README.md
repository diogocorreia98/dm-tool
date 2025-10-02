# DM Toolkit

This project provides a lightweight set of initiative management tools for tabletop DMs and a companion player entry form.

## Player sharing backend

Player sharing now relies on a small WebSocket relay hosted in the `server/` directory. Start the relay before opening `index.html`:

```bash
cd server
npm install
npm start
```

The server listens on port `3001` and exposes a WebSocket endpoint at `/ws`. The front-end will automatically connect to the same host that served `index.html`. To point the UI at a different relay, set `window.DM_TOOL_SOCKET_URL` before loading the page.

## Manual regression checklist

Perform these steps on every release to verify the DM ↔ player flow (ideally using two different browsers or devices):

1. **Start the relay server.** Run `npm start` from the `server/` directory and wait for the "Listening" log.
2. **Host a DM session.** Open `index.html` in a desktop browser, click **Start player session**, and note the session code and share link.
3. **Join as a player from another device/browser.** Open the share link (or `index.html?view=player`) in a separate browser profile/device, enter the DM's code, and wait for the "Connected" status.
4. **Submit an initiative.** From the player view, send an initiative entry and confirm that the DM view receives the combatant and the player sees a success acknowledgement.
5. **Test disconnect behaviour.** Stop the session from the DM view and confirm that the player is notified that the session closed and can no longer submit.

## Development

Open `index.html` directly in a browser or serve it with your preferred static file host. The UI automatically adapts for DM and player views based on the `view=player` query parameter.
