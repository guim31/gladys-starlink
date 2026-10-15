# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- The Starlink dish as a Gladys device, read on the local network through its
  gRPC API (no account, no cloud): online, state, latency, packet loss,
  download and upload throughput, obstructed sky, obstructed right now,
  uptime, power draw, the heating, thermal throttling, overheating shutdown and
  update pending alerts, the snow melt mode and the software version.
- Latency, packet loss, throughput and power averaged over the refresh
  interval (10 s to 1 min) from the dish history.
- The snow melt mode can be set from the device or a scene (automatic, always
  on, off).
- Scene triggers: Starlink connection lost (filterable by cause, including a
  dish that stops answering), Starlink connection restored (with the outage
  duration), Starlink sky obstructed.
- Scene actions and configuration buttons to reboot, stow and deploy the
  dish, refused until "Allow the commands that cut the Internet" is ticked,
  and a connection test.
- A "Starlink" dashboard widget: latency, throughput, obstruction, state,
  active alerts, snow melt mode and uptime.
- English, French, German and Spanish texts and documentation.
- `scripts/probe.mjs`, a read-only check of a real dish.

[Unreleased]: https://github.com/guim31/gladys-starlink/commits/main
