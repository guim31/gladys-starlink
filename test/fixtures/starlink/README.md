# Recorded dish answers

Protobuf messages as the dish sends them (`SpaceX.API.Device.Response`), and
the requests as the Starlink app encodes them (`requests.json`, hex). They are
serialized by the **official protobuf implementation** from the `.proto` files
the dish describes through gRPC reflection, by `generate.py` (instructions at
its top): the integration's own encoder never produced them, so the tests of
`src/starlink/` check the field numbers against the real protocol, not against
themselves.

| File                     | Content                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `status-connected.bin`   | Connected dish, values of the Home Assistant test fixture, config embedded (recent firmware) |
| `status-obstructed.bin`  | Obstructed outage, heating, update pending, slow Ethernet; no config (older firmware)        |
| `status-searching.bin`   | Outage `NO_SCHEDULE` ("searching"), Gen 3 hardware                                           |
| `status-stowed.bin`      | Stowed dish                                                                                  |
| `history.bin`            | 900-sample ring buffer, counter 119395 (wrapped)                                             |
| `config.bin`             | `dish_get_config`: snow melt always off                                                      |
| `reboot.bin`, `stow.bin` | Empty answers to the commands                                                                |
| `set-config.bin`         | Accepted snow melt setting                                                                   |
| `set-config-refused.bin` | Refused setting (`error` field)                                                              |
| `status-error.bin`       | `Response.status` error 12                                                                   |

The dish serial (`ut01000000-00000000-00c0ffee`) is invented.
