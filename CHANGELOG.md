## Change Log

### v1.0.0 (2018/11/22 23:20)
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
