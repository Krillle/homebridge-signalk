## Change Log

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
