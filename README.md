# homebridge-signalk

This a plugin for the Homebridge server, which maps API keys of a Signal K server to matching HomeKit devices.

## General Prerequisites:
The plugin fills the gap between Homebridge and Signal K, so you need both up an running:
- [Signal K server](https://www.npmjs.com/package/signalk-server)
- [Homebridge server] (https://www.npmjs.com/package/homebridge)


## Mapped API keys and devices:
The plugin maps the follwoing [Signal K API keys](http://signalk.org/specification/1.0.0/doc/vesselsBranch.html) to suitable HomeKit devices:

### Environment
The following Signal K standard keys are mapped to temperature and humidity sensors:

/environment/outside/temperature/  
/environment/inside/temperature/  
/environment/inside/engineRoom/temperature/  
/environment/inside/mainCabin/temperature/  
/environment/inside/refrigerator/temperature/  
/environment/inside/freezer/temperature/  
/environment/inside/heating/temperature/  
/environment/water/temperature/

/propulsion/port/temperature
/propulsion/starboard/temperature

/environment/outside/humidity/  
/environment/inside/humidity/  
/environment/inside/engineRoom/relativeHumidity/  
/environment/inside/mainCabin/relativeHumidity/  
/environment/inside/refrigerator/relativeHumidity/  
/environment/inside/freezer/relativeHumidity/  
/environment/inside/heating/relativeHumidity/  

### Tanks
The following Signal K standard keys for tanks are mapped to humidity sensors:

/tanks/*

HomeKit does not support tank sensors yet, so a humidity sensor is the best matching device showing percentages. Tanks on low level (freshwater, fuel, lubrication, live well, gas, ballast) or high level (wastewater, blackwater) show a low battery warning.


### Batteries and Chargers
The following Signal K standard keys for batteries and chargers are mapped to humidity sensors:

/electrical/batteries/*
/electrical/inverterCharger/*

HomeKit does not support batteries as stand alone devices yet, so a humidity sensor is the best matching device showing percentages. Batteries on low level show a low battery warning.


### Raspberry Pi
Keys generated by the [Signal K Raspberry Pi Temperature plugin](https://www.npmjs.com/package/signalk-raspberry-pi-temperature) are mapped to temperature sensors:
/cpu/temperature/

####Prerequisite:
[Signal K Raspberry Pi Temperature plugin](https://www.npmjs.com/package/signalk-raspberry-pi-temperature)


### EmpirBus NXT switches and dimmers
Keys generated by the [Signal K EmpirBus NXT plugin](https://www.npmjs.com/package/signalk-empirbusnxt-plugin) are mapped to switches and dimmers.

####Keys:
/electrical/switches/empirBusNxt-instance0-dimmer0/  
/electrical/switches/empirBusNxt-instance0-switch0/  

####Prerequisite:
[Signal K EmpirBus NXT plugin](https://www.npmjs.com/package/signalk-empirbusnxt-plugin


### Venus GX switches and dimmers
Keys generated by the [Signal K Venus plugin](https://www.npmjs.com/package/signalk-venus-plugin) are mapped to switches and dimmers.

####Keys:
/electrical/switches/venus-0/  
/electrical/switches/venus-1/  

####Prerequisite:
[Signal K Venus plugin](https://www.npmjs.com/package/signalk-venus-plugin)

## Configuration
The plugin awaits and accepts the following settings in the Homebridge `config.json` file:

### Required parameters:
`"platform" : "SignalK"`
`"host": "127.0.0.1:3000"` IP address and port of Signal K server

### Optional parameters:
`"name" : "NameOfVessel"`
`"ssl": false` Set to `true` if Signal K server is awating connections via SSL

"lowBatteryVoltage" : "23.5",
"chargingBatteryVoltage" : "27.5",
"lowFreshWaterLevel" : "25.0",
"highWasteWaterLevel" : "75.0",
"highBlackWaterLevel" : "75.0",
"lowFuelLevel" : "50.0",
"lowLubricationLevel" : "50.0",
"lowLiveWellLevel" : "50.0",
"lowGasLevel" : "50.0",
"lowBallastLevel" : "50.0",

"removeDevicesNotPresent": false,

"ignoredPaths": [
