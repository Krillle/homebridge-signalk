## Change Log

### v1.6.0 (2023/09/03 17:300)
- feature: add support for Shelly switches and dimmers

### v1.5.2 (2023/07/29 17:30)
- fix: fixed TypeError: Cannot read properties of undefined (reading 'meta')

### v1.5.1 (2023/07/24 19:30)
- chore: Adapted to corrected metadata in SignalK-Empirbus-plugin

### v1.5.0 (2022/11/12 18:15)
- feature: Access Requests to request and be granted access to the Signal K server

### v1.4.3 (2021/06/27 14:45)
- fix: battery voltage can be decimal number

### v1.4.2 (2021/05/29 13:00)
- fix: display state of switches and dimmers correctly after switching on

### v1.4.1 (2021/05/07 22:00)
- chore: bump lodash from 4.17.19 to 4.17.21

### v1.4.0 (2021/05/05 22:00)
- feature: reconnect to Signal K after connection was closed
- fix: API key /environment/inside/relativeHumidity/

### v1.3.0 (2021/03/08 00:45)
- feature: add contact sensors for any API key
- feature: battery charging state based on positive current value

### v1.2.5 (2021/02/25 00:15)
- fix: humidity and battery level shall not exceed 100 in Homebridge 1.3
- fix: fixed battery level calculation based on voltage

### v1.2.4 (2021/02/06 15:00)
- chore: Homebridge verified status

### v1.2.3 (2021/01/26 00:30)
- chore: smaller text changes

### v1.2.2 (2021/01/24 23:20)
- fix: collapsed configuration in Homebridge UI

### v1.2.1 (2021/01/12 00:30)
- fix: catch potential Signal K websocket and http errors

### v1.2.0 (2021/01/01 23:00)
- feature: generic switch for any API key /electrical/switches/\<identifier\>/state
- feature: process Venus GX meta data
- fix: catch error caused by missing meta API keys
- fix: catch error caused by updates for unknown devices

### v1.1.1 (2020/12/30 17:20)
- fix: delay removing not present devices to give Signal K time to fill API tree

### v1.1.0 (2020/12/30 01:40)
- feature: update reachability of devices after 10 seconds to give Signal K time to build API tree
- feature: delay first autodetect new devices for 10 seconds to give Signal K time to build API tree
- feature: autodetect new devices every 15 mins
- feature: added configuration in Homebridge UI
- fix: catch error caused by 'meta' delta messages  
- chore: improved removal of devices not present or ignored

### v1.0.3 (2020/12/27 23:00)
- fix: if no ignoredPaths in config.json include any path

### v1.0.2 (2020/12/14 21:30)
- fix: catch error if no ignoredPaths in config.json

### v1.0.1 (2019/01/21 23:30)
- chore: HTTP result logging
- fix: Venus GX relay on/off status is shown correctly

### v1.0.0 (2019/01/12 11:00)
- fix: Venus GX relay on/off status is shown correctly

**Known issues:**
- Venus GX meta data is not processed

### v0.1.0 (2018/11/22 23:20)
**WARNING:** Major change in HomeKit device ID. You will have to delete and newly add all Signal K devices
- feature: EmpirBus NXT switches marked as device type `leakSensor` are shown in Home App as a leak sensor
- fix: change HomeKit device UUID from possibly duplicate path to unique identifier
- fix: Venus GX relay on/off status is shown correctly

**Known issues:**
- Venus GX meta data is not processed

### v0.0.3 (2018/11/04 18:43)
- fix: declaration of dependency was missing

**Known issues:**
- Venus GX meta data is not processed

### v0.0.2 (2018/11/02 16:00)
- fix: crash when Venus GX meta data is missing
- fix: batteries which don't report a state of charge (SOC) to Signal K are shown in Home App as "not responding"
- feature: calculate SOC for batteries which don't report SOC to Signal K (simplified linear SOC based on voltage)
- feature: log Signal K API requests and WebSocket updates

**Known issues:**
- Venus GX meta data is not processed

### v0.0.1 (2018/04/07 23:45)
 Initial working version  

 **Known issues:**
 - Batteries which don't report a state of charge (SOC) to Signal K are shown in Home App as "not responding"
 - Crash when Venus GX meta data is missing
