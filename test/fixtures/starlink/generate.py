# Regenerates the recorded dish answers of this directory with the OFFICIAL
# protobuf implementation, from the .proto files the dish describes through
# gRPC reflection (as published by clarkzjw/starlink-grpc-golang, proto/):
#
#   pip install grpcio-tools protobuf
#   python -m grpc_tools.protoc -I<proto dir> --python_out=gen $(cd <proto dir> && find spacex_api -name '*.proto')
#   python generate.py <this directory>      (with gen/ in the working directory)
#
# The values of status-connected.bin are those of the Home Assistant test
# fixture (tests/components/starlink/fixtures/status_data_success.json); the
# dish serial is invented.
import sys, json, os
sys.path.insert(0, 'gen')
from spacex_api.device import device_pb2, dish_pb2, dish_config_pb2
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
DISH_ID = "ut01000000-00000000-00c0ffee"
SW = "191e4dfa-d63a-46b1-a73b-9fa907733864.uterm.release"

def write(name, msg):
    open(os.path.join(out, name), 'wb').write(msg.SerializeToString())

# 1. Connected, values of the Home Assistant test fixture, recent firmware (config embedded).
r = device_pb2.Response()
s = r.dish_get_status
s.device_info.id = DISH_ID
s.device_info.hardware_version = "rev3_proto2"
s.device_info.software_version = SW
s.device_info.country_code = "FR"
s.device_state.uptime_s = 804138
s.seconds_to_first_nonempty_slot = 0.0
s.pop_ping_drop_rate = 0.0
s.downlink_throughput_bps = 10108.2724609375
s.uplink_throughput_bps = 11802.771484375
s.pop_ping_latency_ms = 30.285715103149414
s.obstruction_stats.fraction_obstructed = 0.0
s.obstruction_stats.valid_s = 803872.0
s.obstruction_stats.currently_obstructed = False
s.boresight_azimuth_deg = -179.00344848632812
s.boresight_elevation_deg = 68.67173767089844
s.is_snr_above_noise_floor = True
s.gps_stats.gps_valid = True
s.gps_stats.gps_sats = 12
s.eth_speed_mbps = 1000
s.software_update_state = dish_pb2.IDLE
s.config.snow_melt_mode = dish_config_pb2.DishConfig.AUTO
s.config.location_request_mode = dish_config_pb2.DishConfig.LOCAL
s.alerts.SetInParent()
r.api_version = 41
write('status-connected.bin', r)

# 2. Obstructed outage, heating, update pending; older firmware: no config in the status.
r = device_pb2.Response()
s = r.dish_get_status
s.device_info.id = DISH_ID
s.device_info.hardware_version = "rev3_proto2"
s.device_info.software_version = SW
s.device_state.uptime_s = 3600 * 5 + 1800
s.pop_ping_drop_rate = 1.0
s.downlink_throughput_bps = 0
s.uplink_throughput_bps = 0
s.pop_ping_latency_ms = 0
s.obstruction_stats.fraction_obstructed = 0.0123
s.obstruction_stats.currently_obstructed = True
s.obstruction_stats.avg_prolonged_obstruction_duration_s = 2.5
s.obstruction_stats.avg_prolonged_obstruction_interval_s = float('nan')
s.outage.cause = dish_pb2.DishOutage.OBSTRUCTED
s.outage.start_timestamp_ns = -1  # negative int64 on the wire: 10-byte varint
s.outage.duration_ns = 12_500_000_000
s.alerts.is_heating = True
s.alerts.install_pending = True
s.alerts.slow_ethernet_speeds = True
s.software_update_state = dish_pb2.REBOOT_REQUIRED
s.swupdate_reboot_ready = True
r.api_version = 41
write('status-obstructed.bin', r)

# 3. Searching (NO_SCHEDULE), stowed.
for name, cause in [('status-searching.bin', dish_pb2.DishOutage.NO_SCHEDULE), ('status-stowed.bin', dish_pb2.DishOutage.STOWED)]:
    r = device_pb2.Response()
    s = r.dish_get_status
    s.device_info.id = DISH_ID
    s.device_info.hardware_version = "rev4_prod1"
    s.device_info.software_version = SW
    s.device_state.uptime_s = 120
    s.outage.cause = cause
    s.outage.duration_ns = 45_000_000_000
    if cause == dish_pb2.DishOutage.STOWED:
        s.stow_requested = True
    write(name, r)

# 4. History: a 900-sample ring buffer, counter 119395 (index 119395 % 900 = 595).
r = device_pb2.Response()
h = r.dish_get_history
h.current = 119395
N = 900
drop = [0.0] * N; lat = [0.0] * N; down = [0.0] * N; up = [0.0] * N; power = [0.0] * N
for c in range(h.current - N, h.current):
    i = c % N
    age = h.current - 1 - c  # 0 = newest
    if age < 30:
        # the last 30 seconds: one full drop, one half drop; latency 20..49 ms
        drop[i] = 1.0 if age == 5 else (0.5 if age == 6 else 0.0)
        lat[i] = 20.0 + age
        down[i] = 50e6 + age * 1e6
        up[i] = 5e6 + age * 1e5
        power[i] = 30.0 + (age % 3)
    else:
        drop[i] = 0.0
        lat[i] = 100.0
        down[i] = 1e6
        up[i] = 1e5
        power[i] = 50.0
h.pop_ping_drop_rate.extend(drop)
h.pop_ping_latency_ms.extend(lat)
h.downlink_throughput_bps.extend(down)
h.uplink_throughput_bps.extend(up)
h.power_in.extend(power)
write('history.bin', r)

# 5. Config (older firmware path).
r = device_pb2.Response()
r.dish_get_config.dish_config.snow_melt_mode = dish_config_pb2.DishConfig.ALWAYS_OFF
r.dish_get_config.dish_config.power_save_mode = True
write('config.bin', r)

# 6. Requests, as the official implementation encodes them.
def req(fill):
    q = device_pb2.Request()
    fill(q)
    return q.SerializeToString().hex()
requests = {
    'getStatus': req(lambda q: q.get_status.SetInParent()),
    'getHistory': req(lambda q: q.get_history.SetInParent()),
    'getConfig': req(lambda q: q.dish_get_config.SetInParent()),
    'reboot': req(lambda q: q.reboot.SetInParent()),
    'stow': req(lambda q: q.dish_stow.SetInParent()),
    'unstow': req(lambda q: setattr(q.dish_stow, 'unstow', True)),
}
def snow(mode):
    def fill(q):
        q.dish_set_config.dish_config.snow_melt_mode = mode
        q.dish_set_config.dish_config.apply_snow_melt_mode = True
    return req(fill)
requests['setSnowMeltMode:auto'] = snow(0)
requests['setSnowMeltMode:always_on'] = snow(1)
requests['setSnowMeltMode:always_off'] = snow(2)
json.dump(requests, open(os.path.join(out, 'requests.json'), 'w'), indent=2)
open(os.path.join(out, 'requests.json'), 'a').write('\n')

# 7. Answers to commands.
r = device_pb2.Response(); r.reboot.SetInParent(); write('reboot.bin', r)
r = device_pb2.Response(); r.dish_stow.SetInParent(); write('stow.bin', r)
r = device_pb2.Response(); r.dish_set_config.updated_dish_config.snow_melt_mode = 1; r.dish_set_config.updated_dish_config.apply_snow_melt_mode = True; write('set-config.bin', r)
r = device_pb2.Response(); r.dish_set_config.error = "snow melt mode not supported"; write('set-config-refused.bin', r)
r = device_pb2.Response(); r.status.code = 12; r.status.message = "unsupported request"; write('status-error.bin', r)
