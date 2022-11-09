const _ = require('lodash');
const keyFileStorage = require("key-file-storage");
var httpLog = require('debug')('homebridge-signalk:http');
var wsLog = require('debug')('homebridge-signalk:websocket');
var request = require('request');
var http = require('http');
var _url = require('url');
var websocket = require("ws");

var Accessory, Service, Characteristic, UUIDGen;

const urlPath = 'signalk/v1/api/vessels/self/'
const wsPath = 'signalk/v1/stream?subscribe=none' // none will stream only the heartbeat, until the client issues subscribe messages in the WebSocket stream
const arPath = 'signalk/v1/access/requests' // Signal K access request path

const defaultsignalkInitializeDelay = 10000 // Delay before adding or removing devices to give Signal K time to build API tree (in milliseconds)
const defaultAutodetectNewAccessoriesInterval = 15 * 60 * 1000 // Interval to check for new devices (in milliseconds)
const defaultAccessRequestInterval = 1 * 60 * 1000 // Interval to check Signal K access request status (in milliseconds)

// EmpirBus NXT + Venus GX switches and dimmer
//
// Key path according to EmpirBus Application Specific PGN Data Model 2 (2x word + 8x bit) per instance:
// 2x dimmer values 0 = off .. 1000 = 100%, 8x switch values 0 = off / 1 = on
//
// electrical.switches.empirBusNxt-instance<NXT component instance 0..49>-switch<#1..8>.state
// electrical.switches.empirBusNxt-instance<NXT component instance 0..49>-dimmer<#1..2>.state
const controlsPath = 'electrical.switches'
const empirBusIdentifier = 'empirBusNxt'
const venusRelaisIdentifier = 'venus'
const controlsPutPath = 'electrical/switches/'

const switchOnValues = [ true, 'true', 'on', 'low power', 'passthrough', '1', 1 ] // All Signal K values which represent a switch is "on"

// Victron Venus GX Chargers
const chargersPath = 'electrical.chargers'
const chargersDevices = [
  { key : 'mode' , displayName : 'Charger Mode' , deviceType : 'switch'},
  { key : 'capacity.stateOfCharge' , displayName : 'Charger SOC' , deviceType : 'batterySOC'}
];

// Environment temperatures + humidity
const environmentPath = 'environment'
const environments = [
  { key : 'outside.temperature' , displayName : 'Outside' , deviceType : 'temperature'},
  { key : 'inside.temperature' , displayName : 'Inside' , deviceType : 'temperature'},
  { key : 'inside.engineRoom.temperature' , displayName : 'Engine Room' , deviceType : 'temperature'},
  { key : 'inside.mainCabin.temperature' , displayName : 'Main Cabin' , deviceType : 'temperature'},
  { key : 'inside.refrigerator.temperature' , displayName : 'Refrigerator' , deviceType : 'temperature'},
  { key : 'inside.freezer.temperature' , displayName : 'Freezer' , deviceType : 'temperature'},
  { key : 'inside.heating.temperature' , displayName : 'Heating' , deviceType : 'temperature'},
  { key : 'water.temperature' , displayName : 'Water' , deviceType : 'temperature'},
  { key : 'cpu.temperature' , displayName : 'Raspberry Pi' , deviceType : 'temperature'},

  { key : 'outside.humidity' , displayName : 'Outside' , deviceType : 'humidity'},
  { key : 'inside.relativeHumidity' , displayName : 'Inside' , deviceType : 'humidity'},
  { key : 'inside.engineRoom.relativeHumidity' , displayName : 'Engine Room' , deviceType : 'humidity'},
  { key : 'inside.mainCabin.relativeHumidity' , displayName : 'Main Cabin' , deviceType : 'humidity'},
  { key : 'inside.refrigerator.relativeHumidity' , displayName : 'Refrigerator' , deviceType : 'humidity'},
  { key : 'inside.freezer.relativeHumidity' , displayName : 'Freezer' , deviceType : 'humidity'},
  { key : 'inside.heating.relativeHumidity' , displayName : 'Heating' , deviceType : 'humidity'}
];

// Tanks
const tanksPath = 'tanks'
const defaultLowFreshWaterLevel = 25.0
const defaultHighWasteWaterLevel = 75.0
const defaultHighBlackWaterLevel = 75.0
const defaultLowFuelLevel = 50.0
const defaultLowLubricationLevel = 50.0
const defaultLowLiveWellLevel = 50.0
const defaultLowGasLevel = 50.0
const defaultLowBallastLevel = 50.0

// Batteries
const batteriesPath = 'electrical.batteries'
const defaultEmptyBatteryVoltage = 22
const defaultLowBatteryVoltage = 23.5
const defaultFullBatteryVoltage = 25.8
const defaultChargingBatteryVoltage = 27

// Engine data
const enginePath = 'propulsion'
const engines = [
  { key : 'port.temperature' , displayName : 'Engine port' , deviceType : 'temperature'},
  { key : 'starboard.temperature' , displayName : 'Engine starboard' , deviceType : 'temperature'}
];

// Contact sensors
var contactSensors = new Map();

// // Accessory types and Services
// const serviceMapping = {
//   'switch': {
//     'devices' : [Service.Switch],
//
//   },
//
//
// };

var errorHandler = (error) => { if ( error ) {
              platform.log('Device unreachable:', error.message)
            } else {
              platform.log('Ok')
            }
    };

module.exports = function(homebridge) {
  // console.log("homebridge API version: " + homebridge.version);

  // Accessory must be created from PlatformAccessory Constructor
  Accessory = homebridge.platformAccessory;

  // Service and Characteristic are from hap-nodejs
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;

  // For platform plugin to be considered as dynamic platform plugin,
  // registerPlatform(pluginName, platformName, constructor, dynamic), dynamic must be true
  homebridge.registerPlatform("homebridge-signalk", "SignalK", SignalKPlatform, true);
}

// Platform constructor
// config may be null
// api may be null if launched from old homebridge version
function SignalKPlatform(log, config, api) {
  log("SignalKPlatform Init");

  if (!(config)) { log ("No Signal K configuration found"); return; }
  if (!(config.host)) { log ("No Signal K host configuration found"); return; }

  var platform = this;
  this.log = log;
  this.config = config;
  this.accessories = new Map();

  this.updateSubscriptions = new Map (); // Devices to update on WebSocket

  this.url = 'http' + (config.ssl ? 's' : '') + '://' + config.host + '/' + urlPath;
  this.wsl = 'ws' + (config.ssl ? 's' : '') + '://' + config.host + '/' + wsPath;
  this.arl = 'http' + (config.ssl ? 's' : '') + '://' + config.host + '/' + arPath;
  this.arHost = this.arl = 'http' + (config.ssl ? 's' : '') + '://' + config.host;

  this.wsOptions = {}
  if (config.securityToken) {
    this.wsOptions.headers = { 'Authorization': 'JWT ' + config.securityToken }
    this.securityToken = config.securityToken
  }
  this.InitiateWebSocket();   // Start accessories value updating

  this.signalkInitializeDelay = Number(config.signalkInitializeDelay) || defaultsignalkInitializeDelay;
  this.autodetectNewAccessoriesInterval = Number(config.autodetectNewAccessoriesInterval) || defaultAutodetectNewAccessoriesInterval;
  this.accessRequestInterval = Number(config.accessRequestInterval) || defaultAccessRequestInterval;

  this.percent = (body) => Math.min(Number(body) * 100,100);
  this.kelvinToCelsius = (body) =>  Number(body) - 273.15;
  this.onOffCondition = (body) => switchOnValues.includes(body);

  this.emptyBatteryVoltage = Number(config.emptyBatteryVoltage) || defaultEmptyBatteryVoltage;
  this.lowBatteryVoltage = Number(config.lowBatteryVoltage) || defaultLowBatteryVoltage;
  this.fullBatteryVoltage = Number(config.fullBatteryVoltage) || defaultFullBatteryVoltage;
  this.chargingBatteryVoltage = Number(config.chargingBatteryVoltage) || defaultChargingBatteryVoltage;

  this.batteryCondition = {
    soc : (voltage) => Math.max(Math.min((Number(voltage) - this.emptyBatteryVoltage) / (this.fullBatteryVoltage - this.emptyBatteryVoltage) * 100, 100),0),
    low : (voltage) =>  Number(voltage) <= this.lowBatteryVoltage,
    chargingVoltage : (voltage) =>  Number(voltage) >= this.chargingBatteryVoltage,
    chargingCurrent : (current) => Number(current) > 0
  }

  this.lowFreshWaterLevel = Number(config.lowFreshWaterLevel) || defaultLowFreshWaterLevel;
  this.highWasteWaterLevel = Number(config.highWasteWaterLevel) || defaultHighWasteWaterLevel;
  this.highBlackWaterLevel = Number(config.highBlackWaterLevel) || defaultHighBlackWaterLevel;
  this.lowFuelLevel = Number(config.lowFuelLevel) || defaultLowFuelLevel;
  this.lowLubricationLevel = Number(config.lowLubricationLevel) || defaultLowLubricationLevel;
  this.lowLiveWellLevel = Number(config.lowLiveWellLevel) || defaultLowLiveWellLevel;
  this.lowGasLevel = Number(config.lowGasLevel) || defaultLowGasLevel;
  this.lowBallastLevel = Number(config.lowBallastLevel) || defaultLowBallastLevel;

  this.tankWarnCondition = {
    freshWater : (level) =>  Number(level) * 100 <= this.lowFreshWaterLevel,
    wasteWater : (level) =>  Number(level) * 100 >= this.highWasteWaterLevel,
    blackWater : (level) =>  Number(level) * 100 >= this.highBlackWaterLevel,
    fuel : (level) =>  Number(level) * 100 <= this.lowFuelLevel,
    lubrication : (level) =>  Number(level) * 100 <= this.lowLubricationLevel,
    liveWell : (level) =>  Number(level) * 100 <= this.lowLiveWellLevel,
    gas : (level) =>  Number(level) * 100 <= this.lowGasLevel,
    ballast : (level) =>  Number(level) * 100 <= this.lowBallastLevel
  }

  // Contact sensors
  if (this.config.contactSensors ) {
    var deviceConversion;
    this.config.contactSensors.forEach(device => {

      device.treshold = device.treshold || 0;

      switch (device.operator) {
        case "==":
          deviceConversion = (value) => value == device.treshold;
          break;
        case "!=":
          deviceConversion = (value) => value != device.treshold;
          break;
        case "<":
          deviceConversion = (value) => Number(value) < Number(device.treshold);
          break;
        case "<=":
          deviceConversion = (value) => Number(value) <= Number(device.treshold);
          break;
        case ">=":
          deviceConversion = (value) => Number(value) >= Number(device.treshold);
          break;
        // case "in":
        //   deviceConversion = value => device.treshold.includes(value);
        //   break;
        default: // defaut is ">":
          deviceConversion = (value) => Number(value) > Number(device.treshold);
          break;
      };

      contactSensors.set(device.key, { // Unique identifier for UUID
        'key' : device.key,
        'name': device.name,
        'operator' : device.operator || ">",
        'treshold' : device.treshold,
        'conversion' : deviceConversion
      })
    });
    // this.contactSensorCondition = (contactSensors.get(accessory.context.identifier) || {}).conversion // || (value) => false;
  };


  // this.requestServer = http.createServer(function(request, response) {
  //   if (request.url === "/add") {
  //     this.addAccessory(new Date().toISOString());
  //     response.writeHead(204);
  //     response.end();
  //   }
  //
  //   if (request.url == "/reachability") {
  //     this.updateAccessoriesReachability();
  //     response.writeHead(204);
  //     response.end();
  //   }
  //
  //   if (request.url == "/remove") {
  //     this.removeAccessory();
  //     response.writeHead(204);
  //     response.end();
  //   }
  // }.bind(this));
  //
  // this.requestServer.listen(18081, function() {
  //   platform.log("Server Listening...");
  // });

  if (api) {
      // Save the API object as plugin needs to register new accessory via this object
      this.api = api;
      
      // Initialie key value store 
      this.kfs = require("key-file-storage")(this.api.user.storagePath, true);
      platform.log("Created keyFileStorage", this.api.user.storagePath);

      // Listen to event "didFinishLaunching", this means homebridge already finished loading cached accessories.
      // Platform Plugin should only register new accessory that doesn't exist in homebridge after this event.
      // Or start discover new accessories.
      this.api.on('didFinishLaunching', function() {
        platform.log("Did finish launching");

        // Remove ignored cached accessories
        if (this.config.ignoredPaths) {
          platform.log("Checking for",this.config.ignoredPaths.length,"ignored devices");
          this.config.ignoredPaths.forEach((path, key, map) => {
            if (platform.accessories.has(path)) {
              platform.removeAccessory(platform.accessories.get(path));
            }
          })
        };

        // Remove abandoned contact sensors
        this.log("Checking for abandoned contact sensors");
        this.accessories.forEach((accessory, key) => {
          if ((accessory.context.deviceType == "contactSensor") && !contactSensors.has(accessory.context.path)) {
            this.removeAccessory(accessory);
          };
        });

        // Check Reachability after Signal K API tree has initialized
        setTimeout(platform.updateAccessoriesReachability.bind(this), platform.signalkInitializeDelay);

        // Remove unreachable accessories after Signal K API tree has initialized
        if (this.config.removeDevicesNotPresent) {
          setTimeout(platform.removeAccessoriesNotPresent.bind(this), platform.signalkInitializeDelay);
        };

        // Initally add new accessories after Signal K API tree has initialized
        setTimeout(platform.autodetectNewAccessories.bind(this), platform.signalkInitializeDelay);

        // Periodically check for new accessories in Signal K
        setInterval(platform.autodetectNewAccessories.bind(this), platform.autodetectNewAccessoriesInterval);

        // Periodically check status of Signal K access request
        if ((this.config.accessRequest || true ) && kfs['requestStatus'] != 'APPROVED') {
          setTimeout(platform.accessRequest.bind(this), platform.accessRequestInterval);
          setInterval(platform.accessRequest.bind(this), platform.accessRequestInterval);
        }

      }.bind(this));
  }
}

// Function invoked when homebridge tries to restore cached accessory.
// Developer can configure accessory at here (like setup event handler).
// Update current value.
SignalKPlatform.prototype.configureAccessory = function(accessory) {
  this.log("Configure Accessory", accessory.displayName);
  var platform = this;

  // Set the accessory to reachable if plugin can currently process the accessory,
  // otherwise set to false and update the reachability later by invoking
  // accessory.updateReachability()
  this.checkKey(accessory.context.path, (error, result) => {
    if (error) {
      platform.log(`${accessory.displayName} not reachable`);
      accessory.reachable = false;
    } else {
      platform.log(`${accessory.displayName} is reachable`);
      accessory.reachable = true;
    }
  })

  // Add Device Services
  switch(accessory.context.deviceType) {
    case 'switch':
      this.addSwitchServices(accessory);
      break;
    case 'dimmer':
      this.addDimmerServices(accessory);
      break;
    case 'temperature':
      this.addTemperatureServices(accessory);
      break;
    case 'humidity':
      this.addHumidityServices(accessory);
      break;
    case 'tank':
      this.addTankServices(accessory);
      break;
    case 'battery' || 'charger':
      this.addVoltageBatteryServices(accessory);
      break;
    case 'batterySOC':
      this.addSOCBatteryServices(accessory);
      break;
    case 'leakSensor':
      this.addLeakServices(accessory);
      break;
    case 'contactSensor':
      this.addContactServices(accessory);
      break;
  }

  this.accessories.set(accessory.context.path, accessory);
}


// Handler will be invoked when user try to config your plugin.
// Callback can be cached and invoke when necessary.
SignalKPlatform.prototype.configurationRequestHandler = function(context, request, callback) {
  this.log("Context: ", JSON.stringify(context));
  this.log("Request: ", JSON.stringify(request));

  // Check the request response
  if (request && request.response && request.response.inputs && request.response.inputs.name) {
    this.addAccessory(request.response.inputs.name);

    // Invoke callback with config will let homebridge save the new config into config.json
    // Callback = function(response, type, replace, config)
    // set "type" to platform if the plugin is trying to modify platforms section
    // set "replace" to true will let homebridge replace existing config in config.json
    // "config" is the data platform trying to save
    callback(null, "platform", true, {"platform":"SignalKPlatform", "otherConfig":"SomeData"});
    return;
  }

  // - UI Type: Input
  // Can be used to request input from user
  // User response can be retrieved from request.response.inputs next time
  // when configurationRequestHandler being invoked

  var respDict = {
    "type": "Interface",
    "interface": "input",
    "title": "Add Accessory",
    "items": [
      {
        "id": "name",
        "title": "Name",
        "placeholder": "Fancy Light"
      }//,
      // {
      //   "id": "pw",
      //   "title": "Password",
      //   "secure": true
      // }
    ]
  }

  // - UI Type: List
  // Can be used to ask user to select something from the list
  // User response can be retrieved from request.response.selections next time
  // when configurationRequestHandler being invoked

  // var respDict = {
  //   "type": "Interface",
  //   "interface": "list",
  //   "title": "Select Something",
  //   "allowMultipleSelection": true,
  //   "items": [
  //     "A","B","C"
  //   ]
  // }

  // - UI Type: Instruction
  // Can be used to ask user to do something (other than text input)
  // Hero image is base64 encoded image data. Not really sure the maximum length HomeKit allows.

  // var respDict = {
  //   "type": "Interface",
  //   "interface": "instruction",
  //   "title": "Almost There",
  //   "detail": "Please press the button on the bridge to finish the setup.",
  //   "heroImage": "base64 image data",
  //   "showActivityIndicator": true,
  // "showNextButton": true,
  // "buttonText": "Login in browser",
  // "actionURL": "https://google.com"
  // }

  // Plugin can set context to allow it track setup process
  context.ts = "Hello";

  // Invoke callback to update setup UI
  callback(respDict);
}


// // Sample function to show how developer can add accessory dynamically from outside event
// SignalKPlatform.prototype.addAccessory = function(accessoryName) {
//   this.log("Add Accessory");
//   var platform = this;
//   var uuid;
//
//   uuid = UUIDGen.generate(accessoryName);
//
//   var newAccessory = new Accessory(accessoryName, uuid);
//   newAccessory.on('identify', function(paired, callback) {
//     platform.log(newAccessory.displayName, "Identify!!!");
//     callback();
//   });
//   // Plugin can save context on accessory to help restore accessory in configureAccessory()
//   // newAccessory.context.something = "Something"
//
//   newAccessory.addService(Service.Lightbulb, "Test Light")
//   .getCharacteristic(Characteristic.On)
//   .on('set', function(value, callback) {
//     platform.log(newAccessory.displayName, "Light -> " + value);
//     callback();
//   });
//
//   this.accessories.push(newAccessory);
//   this.api.registerPlatformAccessories("homebridge-signalk", "SignalK", [newAccessory]);
// }


// Add accessory
SignalKPlatform.prototype.addAccessory = function(accessoryName, identifier, path, manufacturer, model, serialnumber, categoryPath, deviceType) {
  var platform = this;
  var uuid = UUIDGen.generate(identifier); // Changed from 'path' in 0.0.4

  this.log(`Add Accessory: ${accessoryName}, ${path}, ${deviceType}`);

  var newAccessory = new Accessory(accessoryName, uuid);

  // Plugin can save context on accessory to help restore accessory in configureAccessory()
  newAccessory.context.identifier = identifier
  newAccessory.context.path = path
  newAccessory.context.categoryPath = categoryPath
  newAccessory.context.deviceType = deviceType
  newAccessory.context.manufacturer = manufacturer
  newAccessory.context.model = model  // Tank Warning relies on model as tank type
  newAccessory.context.serialnumber = serialnumber

  newAccessory.context.subscriptions = []

  // Add Device Information
  newAccessory.getService(Service.AccessoryInformation)
    .setCharacteristic(Characteristic.Manufacturer, manufacturer)
    .setCharacteristic(Characteristic.Model, model)
    .setCharacteristic(Characteristic.SerialNumber, serialnumber);

  // Add Device Services
  switch(deviceType) {
    case 'switch':
      newAccessory.addService(Service.Switch, accessoryName)
      this.addSwitchServices(newAccessory);
      break;
    case 'dimmer':
      newAccessory.addService(Service.Lightbulb, accessoryName)
      this.addDimmerServices(newAccessory);
      break;
    case 'temperature':
      newAccessory.addService(Service.TemperatureSensor, accessoryName)
      this.addTemperatureServices(newAccessory);
      break;
    case 'humidity':
      newAccessory.addService(Service.HumiditySensor, accessoryName)
      this.addHumidityServices(newAccessory);
      break;
    case 'tank':
      newAccessory.addService(Service.HumiditySensor, accessoryName) // Workaround to show tank level
      newAccessory.addService(Service.BatteryService, accessoryName) // Used for low tank level warning
      this.addTankServices(newAccessory);
      break;
    case 'battery':
      newAccessory.addService(Service.HumiditySensor, accessoryName) // Used as main accessory
      newAccessory.addService(Service.BatteryService, accessoryName)
      this.addVoltageBatteryServices(newAccessory);
      break;
    case 'batterySOC':
      newAccessory.addService(Service.HumiditySensor, accessoryName) // Used as main accessory
      newAccessory.addService(Service.BatteryService, accessoryName)
      this.addSOCBatteryServices(newAccessory);
      break;
    case 'leakSensor':
      newAccessory.addService(Service.LeakSensor, accessoryName)
      this.addLeakServices(newAccessory);
      break;
    case 'contactSensor':
      newAccessory.addService(Service.ContactSensor, accessoryName)
      this.addContactServices(newAccessory);
      break;
  }

  this.accessories.set(path, newAccessory);  // FIXME: Does not allow multiple contact sensors on one path
// console.log(newAccessory);
  this.api.registerPlatformAccessories("homebridge-signalk", "SignalK", [newAccessory]);
}


// Add services for Dimmer to existing accessory object
SignalKPlatform.prototype.addDimmerServices = function(accessory) {
  var platform = this;

  accessory.on('identify', function(paired, callback) {
    platform.log(`Identifying Dimmer Accessory ${accessory.displayName} by off/on/off cycle`);

    // FIXME: Get state of device before cycle
    // var stateBefore;
    // platform.getStatus.bind(platform, path + '.state',this.onOffCondition,(error,value)=> {stateBefore = value});
    // console.log(stateBefore);

    // Off/On/Off/Restore cycle
    platform.setOnOff(accessory.context.identifier, false, errorHandler);
    setTimeout(()=>{platform.setOnOff(accessory.context.identifier, true, errorHandler)
                   }, 250);
    setTimeout(()=>{platform.setOnOff(accessory.context.identifier, false, errorHandler)
                   }, 750);
    // FIXME: Restore original state of device before cycle
    //  setTimeout(()=>{platform.setOnOff(identifier, stateBefore)}, 1000);

    callback();
  });

  var dataPath = accessory.context.path + '.state'
  var subscriptionList = [];

  accessory.getService(Service.Lightbulb)
  .getCharacteristic(Characteristic.On)
  .on('get', this.getStatus.bind(this, dataPath, this.onOffCondition))
  .on('set', function(value, callback) {
    platform.log(`Set dimmer ${accessory.displayName}.state to ${value}`)
    platform.setOnOff(accessory.context.identifier, value, errorHandler)
    callback();
  })

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
  subscription.conversion = this.onOffCondition
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.ws.readyState === websocket.OPEN) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };


  dataPath = accessory.context.path + '.dimmingLevel'
  subscriptionList = [];

  accessory.getService(Service.Lightbulb)
  .getCharacteristic(Characteristic.Brightness)
  .on('get', this.getStatus.bind(this, dataPath, this.percent))
  .on('set', function(value, callback) {
    platform.log(`Set dimmer ${accessory.displayName}.dimmingLevel to ${value}%`)
    platform.SetRatio(accessory.context.identifier, value, errorHandler)
    callback();
  });

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
  subscription.conversion = this.percent
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.ws.readyState === websocket.OPEN) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };
}


// Add services for Switch to existing accessory object
SignalKPlatform.prototype.addSwitchServices = function(accessory) {
  var platform = this;

  const dataPath = accessory.context.path + '.state'
  var subscriptionList = [];

  accessory.getService(Service.Switch)
  .getCharacteristic(Characteristic.On)
  .on('get', this.getStatus.bind(this, dataPath, this.onOffCondition))
  .on('set', function(value, callback) {
    platform.log(`Set switch ${accessory.displayName}.state to ${value}`)
    platform.setOnOff(accessory.context.identifier, value, errorHandler)
    callback();
  });

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.Switch).getCharacteristic(Characteristic.On)
  subscription.conversion = this.onOffCondition
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.ws.readyState === websocket.OPEN) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };
}


// Add services for Temperature Sensor to existing accessory object
SignalKPlatform.prototype.addTemperatureServices = function(accessory) {
  var subscriptionList = [];

  accessory.getService(Service.TemperatureSensor)
  .getCharacteristic(Characteristic.CurrentTemperature)
  .on('get', this.getStatus.bind(this, accessory.context.path, this.kelvinToCelsius));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.TemperatureSensor).getCharacteristic(Characteristic.CurrentTemperature)
  subscription.conversion = this.kelvinToCelsius
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(accessory.context.path, subscriptionList);
  if (this.ws.readyState === websocket.OPEN) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${accessory.context.path}"}]}`)
    accessory.context.subscriptions.push(accessory.context.path)  // Link from accessory to subscription
  };
}


// Add services for Humidity Sensor to existing accessory object
SignalKPlatform.prototype.addHumidityServices = function(accessory) {
  var subscriptionList = [];

  accessory.getService(Service.HumiditySensor)
  .getCharacteristic(Characteristic.CurrentRelativeHumidity)
  .on('get', this.getStatus.bind(this, accessory.context.path, this.percent));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.HumiditySensor).getCharacteristic(Characteristic.CurrentRelativeHumidity)
  subscription.conversion = this.percent
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(accessory.context.path, subscriptionList);
  if (this.ws.readyState === websocket.OPEN) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${accessory.context.path}"}]}`)
    accessory.context.subscriptions.push(accessory.context.path)  // Link from accessory to subscription
  };
}


// Add services for Tanks (mapped as Humidity Sensor) to existing accessory object
SignalKPlatform.prototype.addTankServices = function(accessory) {
  const dataPath = accessory.context.path + '.currentLevel'
  var subscriptionList = [];

  accessory.getService(Service.HumiditySensor)   // Workaround, as Home app does not show tank levels
  .getCharacteristic(Characteristic.CurrentRelativeHumidity)
  .on('get', this.getStatus.bind(this, dataPath, this.percent));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.HumiditySensor).getCharacteristic(Characteristic.CurrentRelativeHumidity)
  subscription.conversion = this.percent
  subscriptionList.push(subscription)

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.StatusLowBattery)
  .on('get', this.getStatus.bind(this, dataPath, this.tankWarnCondition[accessory.context.model]));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.StatusLowBattery)
  subscription.conversion = this.tankWarnCondition[accessory.context.model]
  subscriptionList.push(subscription)

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.BatteryLevel)
  .on('get', this.getStatus.bind(this, dataPath, this.percent));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.BatteryLevel)
  subscription.conversion = this.percent
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.ws.readyState === websocket.OPEN) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };
}


// Add services for Batteries (with Humidity Sensor as main accessory) to existing accessory object
SignalKPlatform.prototype.addVoltageBatteryServices = function(accessory) {
  var dataPath = accessory.context.path + '.voltage'
  var subscriptionList = [];

  accessory.getService(Service.HumiditySensor)   // Mapped to use humidity sensor to show SOC in Home app
  .getCharacteristic(Characteristic.CurrentRelativeHumidity)
  .on('get', this.getStatus.bind(this, dataPath, this.batteryCondition.soc));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.HumiditySensor).getCharacteristic(Characteristic.CurrentRelativeHumidity)
  subscription.conversion = this.batteryCondition.soc
  subscriptionList.push(subscription)

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.BatteryLevel)
  .on('get', this.getStatus.bind(this, dataPath, this.batteryCondition.soc));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.BatteryLevel)
  subscription.conversion = this.batteryCondition.soc
  subscriptionList.push(subscription)

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.StatusLowBattery)
  .on('get', this.getStatus.bind(this, dataPath, this.batteryCondition.low));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.StatusLowBattery)
  subscription.conversion = this.batteryCondition.low
  subscriptionList.push(subscription)

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.ChargingState)
  .on('get', this.getStatus.bind(this, dataPath, this.batteryCondition.chargingVoltage));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.ChargingState)
  subscription.conversion = this.batteryCondition.chargingVoltage
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.ws.readyState === websocket.OPEN) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };
}


// Add services for SOC Batteries (with Humidity Sensor as main accessory) to existing accessory object
SignalKPlatform.prototype.addSOCBatteryServices = function(accessory) {
  var dataPath = accessory.context.path + '.capacity.stateOfCharge'
  var subscriptionList = [];

  accessory.getService(Service.HumiditySensor)   // Mapped to use humidity sensor to show SOC in Home app
  .getCharacteristic(Characteristic.CurrentRelativeHumidity)
  .on('get', this.getStatus.bind(this, dataPath, this.percent));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.HumiditySensor).getCharacteristic(Characteristic.CurrentRelativeHumidity)
  subscription.conversion = this.percent
  subscriptionList.push(subscription)

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.BatteryLevel)
  .on('get', this.getStatus.bind(this, dataPath, this.percent));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.BatteryLevel)
  subscription.conversion = this.percent
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.ws.readyState === websocket.OPEN) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };


  dataPath = accessory.context.path + '.current'
  subscriptionList = [];

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.ChargingState)
  .on('get', this.getStatus.bind(this, dataPath, this.batteryCondition.chargingCurrent));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.ChargingState)
  subscription.conversion = this.batteryCondition.chargingCurrent
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.ws.readyState === websocket.OPEN) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };


  dataPath = accessory.context.path + '.voltage'
  subscriptionList = [];

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.StatusLowBattery)
  .on('get', this.getStatus.bind(this, dataPath, this.batteryCondition.low));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.StatusLowBattery)
  subscription.conversion = this.batteryCondition.low
  subscriptionList.push(subscription)

  // accessory.getService(Service.BatteryService)
  // .getCharacteristic(Characteristic.ChargingState)
  // .on('get', this.getStatus.bind(this, dataPath, this.batteryCondition.chargingVoltage));
  //
  // subscription = new Object ();
  // subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.ChargingState)
  // subscription.conversion = this.batteryCondition.chargingVoltage
  // subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.ws.readyState === websocket.OPEN) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };
}


// Add services for Leak Sensor to existing accessory object
SignalKPlatform.prototype.addLeakServices = function(accessory) {
  const dataPath = accessory.context.path + '.state'
  var subscriptionList = [];

  accessory.getService(Service.LeakSensor)
  .getCharacteristic(Characteristic.LeakDetected)
  .on('get', this.getStatus.bind(this, dataPath, this.onOffCondition))

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.LeakSensor).getCharacteristic(Characteristic.LeakDetected)
  subscription.conversion = this.onOffCondition
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.ws.readyState === websocket.OPEN) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };
}

// Add services for Contact Sensor to existing accessory object
SignalKPlatform.prototype.addContactServices = function(accessory) {
  const dataPath = accessory.context.path
  var subscriptionList = this.updateSubscriptions.get(dataPath) || [];

  var conversion = (contactSensors.get(accessory.context.identifier) || {}).conversion  || ((value) => false);

  accessory.getService(Service.ContactSensor)
  .getCharacteristic(Characteristic.ContactSensorState)
  .on('get', this.getStatus.bind(this, dataPath, conversion))

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.ContactSensor).getCharacteristic(Characteristic.ContactSensorState)
  subscription.conversion = conversion
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.ws.readyState === websocket.OPEN) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };
}


SignalKPlatform.prototype.updateAccessoriesReachability = function() {
  this.log("Update reachability");
  for (var accessory in this.accessories) {
    accessory.updateReachability(false);
  }
}

SignalKPlatform.prototype.removeAccessoriesNotPresent = function() {
  // Remove not reachable accessories: cached accessories no more present in Signal K
  this.log("Remove unreachable devices");
  this.accessories.forEach((accessory, key, map) => {
    this.checkKey(accessory.context.path, (error, result) => {
      if (error && result == 'N/A') {
        this.removeAccessory(accessory);
      }
    })
  });
}

// Remove accessory
SignalKPlatform.prototype.removeAccessory = function(accessory) {
  this.log('Remove Accessory', accessory.displayName);
  this.api.unregisterPlatformAccessories("homebridge-signalk", "SignalK", [accessory]);
  this.accessories.delete(accessory.context.path);
  accessory.context.subscriptions.forEach(subscription => {
    this.updateSubscriptions.delete(subscription);
    // FIXME: Scott 30.12.20: Unsubscribing single websockets is not implementd in Signal K
    // if (this.ws.readyState === websocket.OPEN) {
    //   this.ws.send(`{"context": "vessels.self","unsubscribe":[{"path":"${subscription}"}]}`)
    //   wsLog('removed',`{"context": "vessels.self","unsubscribe":[{"path":"${subscription}"}]}`);
    // }
  })
}

// - - - - - - - - - - - - - - - Signal K specific - - - - - - - - - - - - - -

// Request Signak K Access Token
SignalKPlatform.prototype.accessRequest = function() {

  switch(kfs['requestState']) {
  case '' || 'DENIED':
    
    let clientId = UUIDGen.generate(Date.now());
    let description = "Homebridge " + this.config.name;      
    let headers = {'Content-Type': 'application/json'};
    let body = '{"clientId":"' + clientId + '","description":"' + description + '}';
    
    this.log("Requesting access to Signal K server for " + clientId + " " + description + " at " + this.arl);
    request.post({url: this.arl, headers: headers, body: body},
            (error, response, body) => {
              if ( error ) {
                this.log('Signal K error:',error.message,'(Check Signal K server)');
              } else if ( response.statusCode != 202 ) {
                this.log('Signal K error unexpected response: response code',response.statusCode);
              } else {
                var response = JSON.parse(body);
                
                if ( response.state == 'PENDING' ) {
                  this.log('Signal K response: accepted, status:',response.state);
                  kfs['requestId'] = response.requestId;
                  kfs['requestState'] = response.state;
                  kfs[' requestUrl'] = this.arHost + response.href;
                } else {
                  this.log('Signal K response unexpected status:',response.state);
                }
              }
            }
    )
    break;

  case 'PENDING':
  
    let requestId = kfs['requestId'];
    let requestUrl = kfs['requestUrl'];
    
    this.log("Checking status Signal K access request " + requestID + " at " + requestUrl);
    request({url: requestUrl, headers: {} },
            (error, response, body) => {
              if ( error ) {
                this.log('Signal K error:',error.message,'(Check Signal K server)');
              } else if ( response.statusCode == 202 ) {
                this.log('Access request still PENDING. Signal K response: accepted, status',response.state);

              } else if ( response.statusCode == 400 ) {
                this.log('Access request FAILED', response.message);
                kfs['requestState'] = 'FAILED';
                
              } else if ( response.statusCode == 200 ) {
                var response = JSON.parse(body);
                
                if ( response.accessRequest.permission == 'APPROVED' ) {
                  this.log('Access request APPROVED');
                  kfs['requestState'] = response.accessRequest.permission;
                  kfs['accessToken'] = response.accessRequest.token;
                  kfs['requestUrl'] = this.arHost + response.href;

                } else if ( response.accessRequest.permission == 'DENIED' ) {
                  this.log('Access request DENIED');
                  kfs['requestState'] = response.accessRequest.permission;
                  delete kfs['accessToken'];
                  delete kfs['requestUrl'];
                 
                } else {
                  this.log('Signal K access request unexpected status:', response.accessRequest.permission);
                }
              } else {
                this.log('Signal K error unexpected response: response code',response.statusCode);
              }
            }
    )
    break;
    

  }
}

// Autodetect Devices
// Autodetect from API all HomeKit suitable devices
SignalKPlatform.prototype.autodetectNewAccessories = function() {
  this.log("Autodecting new accessories at " + this.url);

  let headers = {}

  if ( this.securityToken ) {
    headers['Authorization'] = 'JWT ' + this.securityToken
  }

  request({url: this.url,
           headers: headers},
          (error, response, body) => {
            if ( error ) {
              this.log('Signal K error:',error.message,'(Check Signal K server and restart Homebridge)');
            } else if ( response.statusCode != 200 ) {
              this.log('Signal K error unexpected response: response code',response.statusCode)
            } else {
              this.processFullTree(body);
            }
          })
}

// Lookup full API Keys tree for HomeKit suitable devices
SignalKPlatform.prototype.processFullTree = function(body) {

  var tree = JSON.parse(body);

  // Add electrical controls: EmpirBus NXT and Venus GX
  this.log("Adding electrical controls (EmpirBus NXT, Venus GX and generic)");
  var controls = _.get(tree, controlsPath);
  if ( controls ) {
    _.keys(controls).forEach(device => {
      if (this.noignoredPath(`${controlsPath}.${device}`)
            && !this.accessories.has(`${controlsPath}.${device}`)) {

        var path = `${controlsPath}.${device}`;
        var fallbackName = ((controls[device].meta||{}).displayName||{}).value || (controls[device].name||{}).value || device;
        var displayName = this.getName(path, fallbackName);

        if (device.slice(0,empirBusIdentifier.length) == empirBusIdentifier) {
          httpLog(`Preparing EmpirBus NXT device: ${device} \n %O`, controls[device]);
          var deviceType = this.getDeviceType(`${controlsPath}.${device}`) || (controls[device].type||{}).value || "switch";
          var manufacturer = (((controls[device].meta||{}).manufacturer||{}).name||{}).value || "EmpirBus";
          var model = (((controls[device].meta||{}).manufacturer||{}).model||{}).value || "NXT DCM";
          var serialnumber = (controls[device].name||{}).value || device;

          // addAccessory = function(accessoryName, identifier, path, manufacturer, model, serialnumber, categoryPath, deviceType)
          httpLog(`Adding EmpirBus NXT device: \n accessoryName: ${displayName}, identifier: ${device}, path: ${path} \n manufacturer: ${manufacturer}, model: ${model}, serialnumber: ${serialnumber} \n categoryPath: ${controlsPath}, deviceType: ${deviceType}`);
          this.addAccessory(displayName, device, path, manufacturer, model, serialnumber, controlsPath, deviceType);
        } else
        if (device.slice(0,venusRelaisIdentifier.length) == venusRelaisIdentifier) {
          httpLog(`Preparing Venus GX device: ${device} \n %O`, controls[device]);
          var deviceType = "switch";
          var manufacturer = (((controls[device].meta||{}).manufacturer||{}).name||{}).value || "Victron Energy";
          var model = (((controls[device].meta||{}).manufacturer||{}).model||{}).value || "Venus GX";

          // addAccessory = function(accessoryName, identifier, path, manufacturer, model, serialnumber, categoryPath, deviceType)
          httpLog(`Adding Venus GX device: \n accessoryName: ${displayName}, identifier: ${device}, path: ${path} \n manufacturer: ${manufacturer}, model: ${model}, serialnumber: ${device} \n categoryPath: ${controlsPath}, deviceType: ${deviceType}`);
          this.addAccessory(displayName, device, path, manufacturer, model, device, controlsPath, deviceType);
        } else
        if (controls[device].state) { // Device is considered a switch if it has electrical.switches.<indentifier>.state
          httpLog(`Preparing generic device: ${device} \n %O`, controls[device]);
          var deviceType = "switch";
          var manufacturer = (((controls[device].meta||{}).manufacturer||{}).name||{}).value || "Unkown";
          var model = (((controls[device].meta||{}).manufacturer||{}).model||{}).value || "Generic Switch";

          // addAccessory = function(accessoryName, identifier, path, manufacturer, model, serialnumber, categoryPath, deviceType)
          httpLog(`Adding generic device: \n accessoryName: ${displayName}, identifier: ${device}, path: ${path} \n manufacturer: ${manufacturer}, model: ${model}, serialnumber: ${device} \n categoryPath: ${controlsPath}, deviceType: ${deviceType}`);
          this.addAccessory(displayName, device, path, manufacturer, model, device, controlsPath, deviceType);
        }
      }
    })
  };
  this.log('Done');

  // Add environments
  this.log("Adding environment temperature and humidity");
  environments.forEach(device => {
    var path = `${environmentPath}.${device.key}`;
    var environment = _.get(tree, path);
    if ( environment
          && this.noignoredPath(path)
          && !this.accessories.has(path) ) {

      var displayName = this.getName(path, device.displayName);
      var deviceType = device.deviceType;
      var manufacturer = 'NMEA';
      var model = `${device.displayName} Sensor`;

      this.addAccessory(displayName, device.key, path, manufacturer, model, displayName, environmentPath, deviceType);
    }
  });
  this.log('Done');

  // Add tanks
  this.log("Adding tanks");
  var tanks = _.get(tree, tanksPath);
  if ( tanks ) {
    _.keys(tanks).forEach(tankType => {
      _.keys(tanks[tankType]).forEach(instance => {
        var path = `${tanksPath}.${tankType}.${instance}`;
        if (this.noignoredPath(path)
              && !this.accessories.has(path) ) {

          var displayName = _.get(instance, "meta.displayName") || this.getName(path, tankType);
          var deviceType = 'tank';
          var manufacturer = "NMEA";
          var model = tankType;
          var deviceKey = `${tankType}.${instance}`;

          this.addAccessory(displayName, deviceKey, path, manufacturer, model, deviceKey, tanksPath, deviceType);
        }
      })
    });
  }
  this.log('Done');

  // Add batteries
  this.log("Adding batteries");
  var batteries = _.get(tree, batteriesPath);
  if ( batteries ) {
    _.keys(batteries).forEach(instance => {
      var path = `${batteriesPath}.${instance}`;
      if (this.noignoredPath(path)
            && !this.accessories.has(path) ) {

        httpLog('Preparing battery device: \n %O', batteries[instance]);
        var displayName = this.getName(path, `Battery ${instance}`);
        var deviceType = batteries[instance].capacity ? 'batterySOC' : 'battery';
        var manufacturer = "NMEA"; // FIXME: batteries[instance].manufacturer.name.value || "NMEA";
        var model = batteries[instance].capacity ? 'Battery SOC' : 'Battery'; // FIXME: batteries[instance].manufacturer.model.value || "Battery";
        var deviceKey = `batteries.${instance}`;

        // addAccessory = function(accessoryName, identifier, path, manufacturer, model, serialnumber, categoryPath, deviceType)
        httpLog(`Adding battery device: \n accessoryName: ${displayName}, identifier: ${deviceKey}, path: ${path} \n manufacturer: ${manufacturer}, model: ${model}, serialnumber: ${displayName} \n categoryPath: ${batteriesPath}, deviceType: ${deviceType}`);
        this.addAccessory(displayName, deviceKey, path, manufacturer, model, displayName, batteriesPath, deviceType);
      }
    });
  }
  this.log('Done');

  // // Add chargers
  // this.log("Adding chargers");
  // var chargers = _.get(tree, chargersPath);
  // if ( chargers ) {
  //   _.keys(chargers).forEach(instance => {
  //     var chargerInstancePath = `${chargersPath}.${instance}`;
  //
  //     chargersDevices.forEach(device => {
  //       var path = `${chargerInstancePath}.${device.key}`;
  //       var chargerDevice = _.get(tree, path);
  //       if ( chargerDevice
  //             && this.noignoredPath(path)
  //             && !this.accessories.has(path) ) {
  //
  //         httpLog('Preparing charger device: \n %O', chargers[instance]);
  //         var displayName = this.getName(path, device.displayName);
  //         var deviceType = device.deviceType;
  //         var manufacturer = 'Victron';
  //         var model = device.displayName;
  //         var deviceKey = `chargers.${instance}.${deviceType}`;
  //
  //         // addAccessory = function(accessoryName, identifier, path, manufacturer, model, serialnumber, categoryPath, deviceType)
  //         httpLog(`Adding charger device: \n accessoryName: ${displayName}, identifier: ${deviceKey}, path: ${chargerInstancePath} \n manufacturer: ${manufacturer}, model: ${model}, serialnumber: ${displayName} \n categoryPath: ${chargersPath}, deviceType: ${deviceType}`);
  //         this.addAccessory(displayName, deviceKey, chargerInstancePath, manufacturer, model, displayName, chargersPath, deviceType);
  //         // this.log(`Ignoring charger device: ${displayName}, identifier: ${deviceKey}, path: ${chargerInstancePath}`);
  //       }
  //     });
  //
  //   });
  // }
  // this.log('Done');

  // Add engine data
  this.log("Adding engine data");
  engines.forEach(device => {
    var path = `${enginePath}.${device.key}`;
    var engine = _.get(tree, path);
    if ( engine
          && this.noignoredPath(path)
          && !this.accessories.has(path) ) {

      var displayName = this.getName(path, device.displayName);
      var deviceType = device.deviceType;
      var manufacturer = 'NMEA';
      var model = `${device.displayName} Sensor`;

      // addAccessory = function(accessoryName, identifier, path, manufacturer, model, serialnumber, categoryPath, deviceType)
      this.addAccessory(displayName, device.key, path, manufacturer, model, displayName, enginePath, deviceType);
    }
    this.log('Done');
  });

  // Add contact sensors
  // FIXME: Changes in config.json are not affecting already present devices. For updating after creating a unique identifier was needed, as two contact sensors for same path may exist.
  this.log("Adding contact sensors");
  contactSensors.forEach((device, identifier) => {
    var path = device.key;
    if (_.get(tree, device.key)
          && !this.accessories.has(path) ) {

      var displayName = device.name || this.getName(path, device.key);
      var deviceType = 'contactSensor';
      var manufacturer = 'NMEA';
      var model = `${device.operator} ${device.treshold} Sensor`;

      // addAccessory = function(accessoryName, identifier, path, manufacturer, model, serialnumber, categoryPath, deviceType)
      this.addAccessory(displayName, identifier, path, manufacturer, model, path, path, deviceType);
      }
    });
  this.log('Done');
}

// - - - - - - - Helper functions - - - - - - - - - - - - - - - - - - - -

// Returns a potential displayName from config.json
SignalKPlatform.prototype.getName = function(path, defaultName) {
  return (this.config.displayNames && this.config.displayNames[path]) || defaultName
}

// Returns true if path is not an ignored path in config.json
SignalKPlatform.prototype.noignoredPath = function(path) {
  return (!this.config.ignoredPaths || this.config.ignoredPaths.indexOf(path) == -1)
}

// Returns device type if path is in deviceTypes in config.json, else returns false
SignalKPlatform.prototype.getDeviceType = function(path) {
  return (this.config.deviceTypes && this.config.deviceTypes[path]) || false
}

// - - - - - - - Read and write Signal K API keys functions - - - - - - -

// Reads value for path from Signal K API
SignalKPlatform.prototype.getValue = function(path, cb, conversion) {
  var url = this.url + path.replace(/\./g, '/')
  httpLog(`SignalK GET ${url}`)
  let headers = {}

  if ( this.securityToken ) {
    headers['Authorization'] = 'JWT ' + this.securityToken
  }

  request({url: url,
           headers: headers},
          (error, response, body) => {
            if ( error ) {
              httpLog(`response: ${JSON.stringify(response)} body ${JSON.stringify(body)}`)
              cb(error, null)
            } else if ( response.statusCode == 404 ) {
              httpLog(`response: ${response.statusCode} ${response.request.method} ${response.request.uri.path}`)
              cb(new Error('device not present 404'), 'N/A')  // removeAccessory relies on result 'N/A'
            } else if ( response.statusCode != 200 ) {
              httpLog(`response: ${response.statusCode} ${response.request.method} ${response.request.uri.path}`)
              cb(new Error(`invalid response ${response.statusCode}`), null)
            } else {
              httpLog('Ok:', body, '→', conversion(body))
              cb(null, conversion(body))
            }
          })
}

// Checks if device keys are still present
SignalKPlatform.prototype.checkKey = function(path, callback) {
  this.getValue(path, callback,
              (body) => body)
}

SignalKPlatform.prototype.getStatus = function(path, condition, callback) {
  this.getValue(path + '.value', callback, condition)
}

// Writes value for path to Signal K API
SignalKPlatform.prototype.setValue = function(device, context, value, cb) {
  // var url = _url.parse(this.url, true, true)
  // url = `${url.protocol}//${url.host}${putPath}${device}/${value}`

  url = `${this.url}${controlsPutPath}${device}/${context}/`
  this.log(`PUT ${url}`)

  let headers = {
    'Content-Type': 'application/json',
  }
  if ( this.securityToken ) {
    headers['Authorization'] = 'JWT ' + this.securityToken
  }
  request({url: url,
           method: 'PUT',
           headers: headers,
           body: JSON.stringify({value: value})
          },
          (error, response, body) => {
            if ( error ) {
              this.log(`response: ${JSON.stringify(response)} body: ${JSON.stringify(body)}`)
              cb(error, null)
            } else if ( response.statusCode == 401 ) {
              this.log(`response: ${response.statusCode} ${response.request.method} ${response.request.uri.path}`)
              cb(new Error(`missing, bad or expired Signal K security token ${response.statusCode}`), null)
            } else if ( response.statusCode != 200 && response.statusCode != 202 ) {   // EmpirBus response is 200 OK, Venus GX response is 202 SUCCESS
              this.log(`response: ${response.statusCode} ${response.request.method} ${response.request.uri.path}`)
              cb(new Error(`invalid response ${response.statusCode}`), null)
            } else {
              httpLog('Ok')
              cb(null, null)
            }
          })
}

// Set brightness of path as 0..1
SignalKPlatform.prototype.SetRatio = function(device, value, callback) {
  value = value / 100;
  this.setValue(device, 'dimmingLevel', value, callback);
}

// Set the state of path as boolean
SignalKPlatform.prototype.setOnOff = function(device, value, callback) {
  value = (value === true || value === "true") ? 1 : 0;
  this.setValue(device, 'state', value, callback);
}

// - - - - - - - WebSocket Status Update- - - - - - - - - - - - - - - - - -

SignalKPlatform.prototype.InitiateWebSocket = function() {
  platform = this;

  this.ws = new websocket(this.wsl, "ws", this.wsOptions);

  this.ws.on('open', function open() {
    // Build WebSocket subscription string
    var subscriptionPaths = [];
    platform.updateSubscriptions.forEach((subscription, key, map) => {
      subscriptionPaths.push({"path": key})
    });

    var subscriptionMessage = `{"context": "vessels.self","subscribe":${JSON.stringify(subscriptionPaths)}}`
    wsLog(subscriptionMessage);

    platform.ws.send(subscriptionMessage);
    platform.log('websocket Subscription message sent');
  });

  this.ws.on('close', function close(code) {
    platform.log('websocket Closed by server with code', code, 'Reconnect in 5 seconds');
    // connection closed, discard old websocket and create a new one in 5s
    platform.ws = null
    setTimeout(platform.InitiateWebSocket.bind(platform), 5000)
  });

  this.ws.on('ping', function heartbeat(data) {
    platform.log('websocket Heartbeat recieved', data);
  });

  this.ws.on('error', function wserror(e) {
    platform.log('websocket Error:',e.message,'(Check Signal K server and restart Homebridge)');
  });

  this.ws.on('message', function incoming(data) {
    // wsLog('Signal K WebSocket incoming:', data);
    message = JSON.parse(data)

    if ( _.hasIn(message, 'updates') ) {
      latestUpdate = _.last(message.updates)  // We want to update to last status only
      if ( _.hasIn(latestUpdate, 'values') ) {
        latestValue = _.last(latestUpdate.values)
        valuePath = latestValue.path
        valueValue = latestValue.value

        targetList = platform.updateSubscriptions.get(valuePath)
        if (targetList) {
          targetList.forEach(target => {
            wsLog('Updating value:', valuePath, '→', target.characteristic.displayName, '|', valueValue, '→', target.conversion(valueValue), '|', `${target.conversion}`);
            target.characteristic.updateValue(target.conversion(valueValue));
          })
        } else {
          wsLog('Skipping update with values for unknown device:', data);
        }
      } else {
        wsLog('Skipping update without values:', data);
      }
    } else if ( _.hasIn(message, 'name') ) {
      platform.log('websocket Welcome message recieved');
    } else {
      platform.log('websocket Unexpected message recieved:', data);
    }
  });
};
