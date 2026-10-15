# Starlink for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com) that follows a
[Starlink](https://www.starlink.com) dish over the local network, through the gRPC API the Starlink app
uses (`192.168.100.1:9200`). No cloud, no account, no password.

> **Developed without the hardware: feedback welcome.** The integration is built and tested against dish
> answers encoded from the protocol published by the community (see [Credits](#credits)), not against a
> real dish. Please report what works and what does not in the
> [issues](https://github.com/guim31/gladys-starlink/issues).

This project is not affiliated with, endorsed by or sponsored by SpaceX or Starlink.

## Features

- **One device per dish**, identified by the dish's own serial: **online** (yes/no), **state** (connected,
  searching, obstructed, stowed, sleeping, unreachable…), **latency**, **packet loss**, **download** and
  **upload** throughput, **obstructed sky** (%), **obstructed right now**, **uptime**, **power draw**,
  the alerts **heating (snow melt)**, **thermal throttling**, **overheating shutdown** and **update
  pending**, the **snow melt mode** (settable: automatic, always on, off) and the **software version**.
- **Averages, not snapshots**: latency, loss, throughput and power are averaged over the refresh interval
  from the dish's second-by-second history (the status carries a single one-second sample), with the
  status as a fallback.
- **Scene triggers**: _Starlink connection lost_ (after a whole interval offline, or when the dish stops
  answering — filterable by cause), _Starlink connection restored_ (with the outage duration), _Starlink sky
  obstructed_ (once per episode, at most every 10 minutes).
- **Scene actions**: reboot, stow, deploy the dish, set the snow melt mode.
- **Dashboard widget** "Starlink": latency, throughput, obstruction, state, active alerts, snow melt mode,
  uptime.
- **Configuration buttons**: test the connection, reboot, stow, deploy.
- **Safe by default**: reboot, stow and deploy cut the Internet access (Gladys Plus included); they stay
  refused until _Allow the commands that cut the Internet_ is ticked. Nothing is exposed as a switch.
- Texts in **English, French, German and Spanish**.

## Requirements

- Gladys Assistant **5.1.0** or later.
- A Starlink dish reachable from the Gladys host at `192.168.100.1` (or the address you configure). The
  integration runs in a sandboxed container on a Docker bridge network, so it reaches the dish exactly when
  the Gladys host does: with the Starlink router it works as is; with your own router (Starlink router in
  bypass mode, or the Ethernet adapter), most routers reach the dish, otherwise add a static route to
  `192.168.100.1/32` through the router's WAN interface. See [`docs/en.md`](docs/en.md).

## Installation

1. In Gladys, open **Integrations** → **Install from GitHub** and enter the address of this repository:
   `https://github.com/guim31/gladys-starlink` (or install **Starlink** from the catalog once it is
   listed).
2. In **Configuration**, keep `192.168.100.1` unless your network differs, pick the refresh interval and the
   language of the device texts, save, then click **Test the connection to the dish**.
3. Open the **Discover** tab and add the dish.

The user guide is in [`docs/en.md`](docs/en.md) (also in [French](docs/fr.md), [German](docs/de.md) and
[Spanish](docs/es.md)); Gladys links it from the Configuration screen.

## How it works

- The dish serves gRPC without TLS: service `SpaceX.API.Device.Device`, unary method `Handle(Request)`.
  The integration speaks it with Node's built-in `http2` module and a ~200-line protobuf codec
  ([`src/starlink/`](src/starlink)): **no runtime dependency** besides the Gladys SDK, nothing heavy in the
  256 MB sandbox, no `.proto` compilation. Only the fields it uses are decoded, by number; unknown fields are
  skipped, so firmware additions are harmless.
- Every interval (10 s to 1 min, 30 s by default) the container reads `get_status` and `get_history`
  (≈ 1 KB and ≈ 25 KB), plus `dish_get_config` on firmware whose status does not carry the configuration.
  It publishes only the values that changed (`publishChangedStates`), with a 6-hour heartbeat.
- The container polls on its **own timer**: the core cannot be trusted to call `onPoll`
  ([Gladys#3198](https://github.com/GladysAssistant/Gladys/issues/3198)). The core's poll stays as a
  fallback, skipped when the timer has just read the dish.
- An outage is reported to the scenes once it lasted two readings in a row (one interval); two failed
  reads in a row mark the dish unreachable. An outage under way when Gladys starts is not reported.
- `scripts/probe.mjs [address]` reads a real dish with the integration's client — read only (status,
  history, config), dish serial masked — and lists the status fields the integration does not read, to spot
  firmware changes.

## Verified, and what was not

Verified here:

- The decoder against answers serialized by the **official protobuf implementation** from the published
  `.proto` files (connected, obstructed with alerts, searching, stowed, a 900-sample history, the config,
  errors), and the requests **byte for byte** against the official encoding
  ([`test/fixtures/starlink`](test/fixtures/starlink)).
- The gRPC transport against a real HTTP/2 server: success, gRPC errors, HTTP errors, timeouts, refused
  connections.
- The whole integration against the SDK's fake Gladys, which validates payloads like the host API.

Not verified (no dish, no Gladys instance during development):

- A real dish answering this client (the probe script is there for that), and the current firmware still
  using these field numbers.
- Reaching `192.168.100.1` from the Gladys container behind third-party routers.
- The power draw reported by every hardware generation, and the rendering of the device and widget in
  Gladys.

## Limitations

- The dish API is unofficial and may change with any firmware update.
- One dish per installation; the Starlink Wi-Fi router is not read.
- Download and upload are the traffic going through the dish, not the link capacity.
- No obstruction map, GPS position or sleep schedule.
- An outage shorter than one refresh interval may go unnoticed.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
node scripts/probe.mjs 192.168.100.1   # against a real dish, read only
```

The tests use the fake Gladys of the SDK (`@gladysassistant/integration-sdk/testing`) and a fake dish
(`test/helpers/fakeDish.js`): a real gRPC server on `127.0.0.1` answering the recorded protobuf answers of
`test/fixtures/starlink/`. See [`CLAUDE.md`](CLAUDE.md) for the project rules. Versions are published by
the Release workflow (**Actions → Release**), never by hand.

## Credits

- [starlink-grpc-tools](https://github.com/sparky8512/starlink-grpc-tools) by sparky8512 and contributors
  (Unlicense): the reference description of the dish API — states, alerts, history ring buffer, commands —
  whose semantics this integration re-implements in JavaScript.
- Home Assistant's [`starlink`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/starlink)
  integration (Apache-2.0) and its tests: the choice of sensors and commands, and the values of the
  connected-dish fixture.
- [starlink-rs](https://github.com/ewilken/starlink-rs) by Elias Wilken (MIT / Apache-2.0) and
  [starlink-grpc-golang](https://github.com/clarkzjw/starlink-grpc-golang) by clarkzjw: the `.proto` files
  extracted from the dish by reflection, read for the field numbers and used — outside this repository — to
  generate the test fixtures; none of their code is included.
- The architecture and the conformity tests follow
  [gladys-wled](https://github.com/guim31/gladys-wled) and
  [gladys-subsonic](https://github.com/guim31/gladys-subsonic).

## Disclaimer

This project is not affiliated with, endorsed or sponsored by SpaceX or Starlink. "Starlink" is a trademark
of Space Exploration Technologies Corp.

## License

Apache-2.0
