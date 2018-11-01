const _ = require('lodash');
var debug = require('debug')('homebridge-signalk');
var request = require('request');
var http = require('http');
var _url = require('url');
var websocket = require("ws");

var Accessory, Service, Characteristic, UUIDGen;

const urlPath = 'signalk/v1/api/vessels/self/'
const wsPath = 'signalk/v1/stream?subscribe=none' // none will stream only the heartbeat, until the client issues subscribe messages in the WebSocket stream

// EmpirBus NXT + Venus GX
//
// Key path according to EmpirBus Application Specific PGN Data Model 2 (2x word + 8x bit) per instance:
// 2x dimmer values 0 = off .. 1000 = 100%, 8x switch values 0 = off / 1 = on
//
// electrical.switches.empirBusNxt-instance<NXT component instance 0..49>-switch<#1..8>.state
// electrical.switches.empirBusNxt-instance<NXT component instance 0..49>-dimmer<#1..2>.state
const controlsPath = 'electrical.switches'
const empirBusIdentifier = 'empirBusNxt'
const controlsPutPath = 'electrical/switches/'

const venusRelaisIdentifier = 'venus'

// Environment temperatures + humidity
const environmentPath = 'environment'
const environments = [
  { key : 'outside.temperature' , displayName : 'Outside' , devicetype : 'temperature'},
  { key : 'inside.temperature' , displayName : 'Inside' , devicetype : 'temperature'},
  { key : 'inside.engineRoom.temperature' , displayName : 'Engine Room' , devicetype : 'temperature'},
  { key : 'inside.mainCabin.temperature' , displayName : 'Main Cabin' , devicetype : 'temperature'},
  { key : 'inside.refrigerator.temperature' , displayName : 'Refrigerator' , devicetype : 'temperature'},
  { key : 'inside.freezer.temperature' , displayName : 'Freezer' , devicetype : 'temperature'},
  { key : 'inside.heating.temperature' , displayName : 'Heating' , devicetype : 'temperature'},
  { key : 'water.temperature' , displayName : 'Water' , devicetype : 'temperature'},
  { key : 'cpu.temperature' , displayName : 'Raspberry Pi' , devicetype : 'temperature'},

  { key : 'outside.humidity' , displayName : 'Outside' , devicetype : 'humidity'},
  { key : 'inside.humidity' , displayName : 'Inside' , devicetype : 'humidity'},
  { key : 'inside.engineRoom.relativeHumidity' , displayName : 'Engine Room' , devicetype : 'humidity'},
  { key : 'inside.mainCabin.relativeHumidity' , displayName : 'Main Cabin' , devicetype : 'humidity'},
  { key : 'inside.refrigerator.relativeHumidity' , displayName : 'Refrigerator' , devicetype : 'humidity'},
  { key : 'inside.freezer.relativeHumidity' , displayName : 'Freezer' , devicetype : 'humidity'},
  { key : 'inside.heating.relativeHumidity' , displayName : 'Heating' , devicetype : 'humidity'}
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

// Batteries and chargers
const batteriesPath = 'electrical.batteries'
const inverterChargerPath = 'electrical.inverterCharger'
const defaultEmptyBatteryVoltage = 22
const defaultLowBatteryVoltage = 23
const defaultFullBatteryVoltage = 26
const defaultChargingBatteryVoltage = 27.5

// Engine data
const enginePath = 'propulsion'
const engines = [
  { key : 'port.temperature' , displayName : 'Engine port' , devicetype : 'temperature'},
  { key : 'starboard.temperature' , displayName : 'Engine starboard' , devicetype : 'temperature'}
];


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

  if (!(config)) { log ("No Signal K configuration found."); return; }
  if (!(config.host)) { log ("No Signal K host configuration found."); return; }

  var platform = this;
  this.log = log;
  this.config = config;
  this.accessories = new Map();

  this.updateSubscriptions = new Map (); // Devices to update on WebSocket

  this.url = 'http' + (config.ssl ? 's' : '') + '://' + config.host + '/' + urlPath;
  this.wsl = 'ws' + (config.ssl ? 's' : '') + '://' + config.host + '/' + wsPath;

  let wsOptions = {}
  if (config.securityToken) {
    wsOptions.headers = { 'Authorization': 'JWT ' + config.securityToken }
    this.securityToken = config.securityToken
  }
  this.ws = new websocket(this.wsl, "ws", wsOptions);
  this.wsInitiated = false;

  this.emptyBatteryVoltage = Number(config.emptyBatteryVoltage) || defaultEmptyBatteryVoltage;
  this.lowBatteryVoltage = Number(config.lowBatteryVoltage) || defaultLowBatteryVoltage;
  this.fullBatteryVoltage = Number(config.fullBatteryVoltage) || defaultFullBatteryVoltage;
  this.chargingBatteryVoltage = Number(config.chargingBatteryVoltage) || defaultChargingBatteryVoltage;

  // this.batteryStateOfCharge = {
  //   (voltage) =>  (Number(voltage) - this.emptyBatteryVoltage) / (this.fullBatteryVoltage - this.emptyBatteryVoltage) * 100
  // }

  this.batteryWarnCondition = {
    low : (voltage) =>  Number(voltage) <= this.lowBatteryVoltage,
    charging : (voltage) =>  Number(voltage) >= this.chargingBatteryVoltage
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

      // Listen to event "didFinishLaunching", this means homebridge already finished loading cached accessories.
      // Platform Plugin should only register new accessory that doesn't exist in homebridge after this event.
      // Or start discover new accessories.
      this.api.on('didFinishLaunching', function() {
        platform.log("Did finish launching");

        // Remove not reachable accessories: cached accessories no more present in Signal K
        platform.log("Checking for unreachable devices");
        platform.accessories.forEach((accessory, key, map) => {
          platform.checkKey(accessory.context.path, (error, result) => {
            if (error && error.message == 'device not present: 404' && config.removeDevicesNotPresent || !this.noignoredPath(accessory.context.path)) {
              platform.log(`${accessory.displayName} not present or ignored`);
              platform.removeAccessory(accessory);
            }
          })
        });

        // Start accessories value updating
        platform.InitiateWebSocket()
        this.wsInitiated = true;

        // Addd new accessories in Signal K
        platform.log("Looking for new accessories");
        platform.autodetectNewAccessories()

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

  // FIXME: Ignored paths are added anyway
  // FIXME: Results in crash ws updates when ignored or unreachable device is deleted afterwards
  // Add Device Services
  switch(accessory.context.devicetype) {
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
    case 'leak':
      this.addLeakServices(accessory);
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
//   // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
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
SignalKPlatform.prototype.addAccessory = function(accessoryName, identifier, path, manufacturer, model, serialnumber, categoryPath, devicetype) {
  var platform = this;
  var uuid = UUIDGen.generate(path);

  this.log(`Add Accessory ${accessoryName}: ${path}, ${devicetype}`);

  var newAccessory = new Accessory(accessoryName, uuid);

  // Plugin can save context on accessory to help restore accessory in configureAccessory()
  newAccessory.context.identifier = identifier
  newAccessory.context.path = path
  newAccessory.context.categoryPath = categoryPath
  newAccessory.context.devicetype = devicetype
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
  switch(devicetype) {
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
      // newAccessory.addService(Service.LeakSensor, accessoryName)
      newAccessory.addService(Service.HumiditySensor, accessoryName) // Workaround to shoe tank level
      newAccessory.addService(Service.BatteryService, accessoryName) // Used for low tank level warning
      this.addTankServices(newAccessory);
      break;
    case 'battery' || 'charger':
      newAccessory.addService(Service.HumiditySensor, accessoryName) // Used as main accessory
      newAccessory.addService(Service.BatteryService, accessoryName)
      this.addVoltageBatteryServices(newAccessory);
      break;
    case 'batterySOC':
      newAccessory.addService(Service.HumiditySensor, accessoryName) // Used as main accessory
      newAccessory.addService(Service.BatteryService, accessoryName)
      this.addSOCBatteryServices(newAccessory);
      break;
    case 'leak':
      newAccessory.addService(Service.LeakSensor, accessoryName)
      this.addLeakServices(newAccessory);
      break;
  }

  this.accessories.set(path, newAccessory);
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
    // platform.getOnOff.bind(platform, path + '.state',(error,value)=> {stateBefore = value});
    // console.log(stateBefore);

    // Off/On/Off/Restore cycle
    platform.setOnOff(accessory.context.identifier, false, ()=> {console.log('FIXME: Device unreachable');});
    setTimeout(()=>{platform.setOnOff(accessory.context.identifier, true, ()=> {console.log('FIXME: Device unreachable');}) // FIXME: Device unreachable
                   }, 250);
    setTimeout(()=>{platform.setOnOff(accessory.context.identifier, false, ()=> {console.log('FIXME: Device unreachable');}) // FIXME: Device unreachable
                   }, 750);
    // FIXME: Restore original state of device before cycle
    //  setTimeout(()=>{platform.setOnOff(identifier, stateBefore)}, 1000);

    callback();
  });

  // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
  var dataPath = accessory.context.path + '.state'
  var subscriptionList = [];

  accessory.getService(Service.Lightbulb)
  .getCharacteristic(Characteristic.On)
  .on('get', this.getOnOff.bind(this, dataPath))
  .on('set', function(value, callback) {
    platform.log(`Set dimmer ${accessory.displayName}.state to ${value}`)
    platform.setOnOff(accessory.context.identifier, value, ()=> {console.log('FIXME: Device unreachable');}) // FIXME: Device unreachable
    callback();
  })

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
  subscription.conversion = (body) => body == true
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.wsInitiated) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };


  dataPath = accessory.context.path + '.dimmingLevel'
  subscriptionList = [];

  accessory.getService(Service.Lightbulb)
  .getCharacteristic(Characteristic.Brightness)
  .on('get', this.getRatio.bind(this, dataPath))
  .on('set', function(value, callback) {
    platform.log(`Set dimmer ${accessory.displayName}.dimmingLevel to ${value}%`)
    platform.SetRatio(accessory.context.identifier, value, ()=> {console.log('FIXME: Device unreachable');}) // FIXME: Device unreachable
    callback();
  });

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.Brightness)
  subscription.conversion = (body) =>  Number(body) * 100
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.wsInitiated) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };
}


// Add services for Switch to existing accessory object
SignalKPlatform.prototype.addSwitchServices = function(accessory) {
  var platform = this;

  // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
  const dataPath = accessory.context.path + '.state'
  var subscriptionList = [];

  accessory.getService(Service.Switch)
  .getCharacteristic(Characteristic.On)
  .on('get', ()=> {this.getOnOff.bind(this, dataPath); debug('ping')})
  .on('set', function(value, callback) {
    platform.log(`Set switch ${accessory.displayName}.state to ${value}`)
    platform.setOnOff(accessory.context.identifier, value, ()=> {console.log('FIXME: Device unreachable');}) // FIXME: Device unreachable
    callback();
  });

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.Switch).getCharacteristic(Characteristic.On)
  subscription.conversion = (body) => body == true
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.wsInitiated) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };
}


// Add services for Temperature Sensor to existing accessory object
SignalKPlatform.prototype.addTemperatureServices = function(accessory) {
  // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
  var subscriptionList = [];

  accessory.getService(Service.TemperatureSensor)
  .getCharacteristic(Characteristic.CurrentTemperature)
  .on('get', this.getTemperature.bind(this, accessory.context.path));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.TemperatureSensor).getCharacteristic(Characteristic.CurrentTemperature)
  subscription.conversion = (body) =>  Number(body) - 273.15
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(accessory.context.path, subscriptionList);
  if (this.wsInitiated) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${accessory.context.path}"}]}`)
    accessory.context.subscriptions.push(accessory.context.path)  // Link from accessory to subscription
  };
}


// Add services for Humidity Sensor to existing accessory object
SignalKPlatform.prototype.addHumidityServices = function(accessory) {
  // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
  var subscriptionList = [];

  accessory.getService(Service.HumiditySensor)
  .getCharacteristic(Characteristic.CurrentRelativeHumidity)
  .on('get', this.getRatio.bind(this, accessory.context.path));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.HumiditySensor).getCharacteristic(Characteristic.CurrentRelativeHumidity)
  subscription.conversion = (body) =>  Number(body) * 100
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(accessory.context.path, subscriptionList);
  if (this.wsInitiated) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${accessory.context.path}"}]}`)
    accessory.context.subscriptions.push(accessory.context.path)  // Link from accessory to subscription
  };
}


// Add services for Tanks (mapped as Humidity Sensor) to existing accessory object
SignalKPlatform.prototype.addTankServices = function(accessory) {
  // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
  const dataPath = accessory.context.path + '.currentLevel'
  var subscriptionList = [];

  accessory.getService(Service.HumiditySensor)   // Workaround, as Home app does not show tank levels
  .getCharacteristic(Characteristic.CurrentRelativeHumidity)
  .on('get', this.getRatio.bind(this, dataPath));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.HumiditySensor).getCharacteristic(Characteristic.CurrentRelativeHumidity)
  subscription.conversion = (body) =>  Number(body) * 100
  subscriptionList.push(subscription)

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.StatusLowBattery)
  .on('get', this.getStatusLowTank.bind(this, dataPath, this.tankWarnCondition[accessory.context.model]));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.StatusLowBattery)
  subscription.conversion = this.tankWarnCondition[accessory.context.model]
  subscriptionList.push(subscription)

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.BatteryLevel)
  .on('get', this.getRatio.bind(this, dataPath));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.BatteryLevel)
  subscription.conversion = (body) =>  Number(body) * 100
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.wsInitiated) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };
}


// Add services for Batteries (with Humidity Sensor as main accessory) to existing accessory object
SignalKPlatform.prototype.addVoltageBatteryServices = function(accessory) {
  // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
  var dataPath = accessory.context.path + '.voltage'
  var subscriptionList = [];

  accessory.getService(Service.HumiditySensor)   // Mapped to use humidity sensor to show SOC in Home app
  .getCharacteristic(Characteristic.CurrentRelativeHumidity)
  .on('get', this.getRatio.bind(this, dataPath));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.HumiditySensor).getCharacteristic(Characteristic.CurrentRelativeHumidity)
  subscription.conversion = (voltage) =>  (Number(voltage) - this.emptyBatteryVoltage) / (this.fullBatteryVoltage - this.emptyBatteryVoltage) * 100
  subscriptionList.push(subscription)

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.BatteryLevel)
  .on('get', this.getRatio.bind(this, dataPath));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.BatteryLevel)
  subscription.conversion = (voltage) =>  (Number(voltage) - this.emptyBatteryVoltage) / (this.fullBatteryVoltage - this.emptyBatteryVoltage) * 100
  subscriptionList.push(subscription)

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.StatusLowBattery)
  .on('get', this.getStatusWarnBattery.bind(this, dataPath, this.batteryWarnCondition.low));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.StatusLowBattery)
  subscription.conversion = this.batteryWarnCondition.low
  subscriptionList.push(subscription)

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.ChargingState)
  .on('get', this.getStatusWarnBattery.bind(this, dataPath, this.batteryWarnCondition.charging));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.ChargingState)
  subscription.conversion = this.batteryWarnCondition.charging
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.wsInitiated) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };

  // dataPath = accessory.context.path + '.chargingMode'
  // accessory.getService(Service.BatteryService)
  // .getCharacteristic(Characteristic.ChargingState)
  // .on('get', this.getChargingState.bind(this, dataPath));
  //
  // subscriptionList = [];
  // subscription = new Object ();
  // subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.ChargingState)
  // subscription.conversion = (body) =>  notChargingValues.indexOf(body) == -1 ? 1 : 0
  // subscriptionList.push(subscription)
  //
  // this.updateSubscriptions.set(dataPath, subscriptionList);
  // if (this.wsInitiated) {
  //   this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
  //   accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  // };

}


// Add services for SOC Batteries (with Humidity Sensor as main accessory) to existing accessory object
SignalKPlatform.prototype.addSOCBatteryServices = function(accessory) {
  // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
  var dataPath = accessory.context.path + '.capacity.stateOfCharge'
  var subscriptionList = [];

  accessory.getService(Service.HumiditySensor)   // Mapped to use humidity sensor to show SOC in Home app
  .getCharacteristic(Characteristic.CurrentRelativeHumidity)
  .on('get', this.getRatio.bind(this, dataPath));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.HumiditySensor).getCharacteristic(Characteristic.CurrentRelativeHumidity)
  subscription.conversion = (body) =>  Number(body) * 100
  subscriptionList.push(subscription)

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.BatteryLevel)
  .on('get', this.getRatio.bind(this, dataPath));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.BatteryLevel)
  subscription.conversion = (body) =>  Number(body) * 100
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.wsInitiated) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };


  // dataPath = accessory.context.path + '.chargingMode'
  // accessory.getService(Service.BatteryService)
  // .getCharacteristic(Characteristic.ChargingState)
  // .on('get', this.getChargingState.bind(this, dataPath));
  //
  // subscriptionList = [];
  // subscription = new Object ();
  // subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.ChargingState)
  // subscription.conversion = (body) =>  notChargingValues.indexOf(body) == -1 ? 1 : 0
  // subscriptionList.push(subscription)
  //
  // this.updateSubscriptions.set(dataPath, subscriptionList);
  // if (this.wsInitiated) {
  //   this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
  //   accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  // };


  dataPath = accessory.context.path + '.voltage'
  subscriptionList = [];

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.StatusLowBattery)
  .on('get', this.getStatusWarnBattery.bind(this, dataPath, this.batteryWarnCondition.low));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.StatusLowBattery)
  subscription.conversion = this.batteryWarnCondition.low
  subscriptionList.push(subscription)

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.ChargingState)
  .on('get', this.getStatusWarnBattery.bind(this, dataPath, this.batteryWarnCondition.charging));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.BatteryService).getCharacteristic(Characteristic.ChargingState)
  subscription.conversion = this.batteryWarnCondition.charging
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.wsInitiated) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };
}


// Add services for Leak Sensor to existing accessory object
SignalKPlatform.prototype.addLeakServices = function(accessory) {
  // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
  const dataPath = accessory.context.path + '.state'
  var subscriptionList = [];

  accessory.getService(Service.LeakSensor)
  .getCharacteristic(Characteristic.LeakDetected)
  .on('get', this.getOnOff.bind(this, dataPath))

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.LeakSensor).getCharacteristic(Characteristic.LeakDetected)
  subscription.conversion = (body) => body == true
  subscriptionList.push(subscription)

  this.updateSubscriptions.set(dataPath, subscriptionList);
  if (this.wsInitiated) {
    this.ws.send(`{"context": "vessels.self","subscribe":[{"path":"${dataPath}"}]}`)
    accessory.context.subscriptions.push(dataPath)  // Link from accessory to subscription
  };
}


SignalKPlatform.prototype.updateAccessoriesReachability = function() {
  this.log("Update Reachability");
  for (var accessory in this.accessories) {
    accessory.updateReachability(false);
  }
}

// Remove accessory
SignalKPlatform.prototype.removeAccessory = function(accessory) {
  this.log('Remove accessory', accessory.displayName);
  this.api.unregisterPlatformAccessories("homebridge-signalk", "SignalK", [accessory]);
  this.accessories.delete(accessory.context.path);
  this.updateSubscriptions.delete(accessory.context.path);
  accessory.context.subscriptions.forEach(subscription => {
    this.ws.send(`{"context": "vessels.self","unsubscribe":[{"path":"${subscription}"}]}`)
    console.log('removed',`{"context": "vessels.self","unsubscribe":[{"path":"${subscription}"}]}`);
  })
}

// - - - - - - - - - - - - - - - Signal K specific - - - - - - - - - - - - - -

// Autodetect Devices
// Autodetect from API all Dimmers, Switches
SignalKPlatform.prototype.autodetectNewAccessories = function() {
  this.log("Autodecting " + this.url);

  let headers = {}

  if ( this.securityToken ) {
    headers['Authorization'] = 'JWT ' + this.securityToken
  }

  request({url: this.url,
           headers: headers},
          (error, response, body) => {
            if ( error ) {
              this.log(`error: ${error}`);
            } else if ( response.statusCode != 200 ) {
              this.log(`error: response code ${response.statusCode}`)
            } else {
              this.processFullTree(body);
            }
          })
}

// Lookup full API Keys tree for HomeKit suitable devices
SignalKPlatform.prototype.processFullTree = function(body) {

  var tree = JSON.parse(body);

  // Add electrical controls: EmpirBus NXT and Venus GX
  this.log("Adding electrical controls (EmpirBus NXT and Venus GX)");
  var controls = _.get(tree, controlsPath);
  if ( controls ) {
    _.keys(controls).forEach(device => {

      if (device.slice(0,empirBusIdentifier.length) == empirBusIdentifier
            && this.noignoredPath(`${controlsPath}.${device}`)
            && !this.accessories.has(`${controlsPath}.${device}`) ) {
        var path = `${controlsPath}.${device}`;
        var fallbackName = controls[device].meta.displayName ? controls[device].meta.displayName.value : controls[device].name.value;
        var displayName = this.getName(path, fallbackName);
        var devicetype = controls[device].type.value;
        var manufacturer = controls[device].meta.manufacturer.name.value || "EmpirBus";
        var model = controls[device].meta.manufacturer.model.value || "NXT DCM";

        this.addAccessory(displayName, device, path, manufacturer, model, controls[device].name.value, controlsPath, devicetype);
      } else
      if (device.slice(0,venusRelaisIdentifier.length) == venusRelaisIdentifier
            && this.noignoredPath(`${controlsPath}.${device}`)
            && !this.accessories.has(`${controlsPath}.${device}`) ) {

        this.log(`Preparing Venus GX device ${device} ${JSON.stringify(controls[device])}`);
        var path = `${controlsPath}.${device}`;
        var fallbackName = device; // FIXME: catch error in case of missing Metadata: controls[device].meta.displayName ? (controls[device].meta.displayName.value ? controls[device].meta.displayName.value : controls[device].meta.displayName) : controls[device].name.value;
        var displayName = this.getName(path, fallbackName);
        var devicetype = "switch";
        var manufacturer = "Victron Energy"; // FIXME: catch error in case of missing Metadata: _.get(controls[device], "meta.manufacturer.name.value") || "Victron Energy";
        var model = "Venus GX"; // FIXME: catch error in case of missing Metadata: _.get(controls[device], "meta.manufacturer.model.value") || "Venus GX";

        if ( !fallbackName ) {
          let parts = device.split('.')
          fallbackName = parts[parts.length-1]
        }

        this.addAccessory(displayName, device, path, manufacturer, model, device, controlsPath, devicetype);
      }
    });
  }
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
      var devicetype = device.devicetype;
      var manufacturer = 'NMEA';
      var model = `${device.displayName} Sensor`;

      this.addAccessory(displayName, device.key, path, manufacturer, model, displayName, environmentPath, devicetype);
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
          var deviceType = 'tank'; //
          var manufacturer = "NMEA"; // chargers[instance].manufacturer.name.value || "NMEA";
          var model = tankType; // chargers[instance].manufacturer.model.value || "Charger";
          var deviceKey = `${tankType}.${instance}`

          this.addAccessory(displayName, deviceKey, path, manufacturer, model, deviceKey, tanksPath, deviceType);
        }
      })
    });
  }
  this.log('Done');

  // Add batteries and chargers
  this.log("Adding batteries");
  var batteries = _.get(tree, batteriesPath);
  if ( batteries ) {
    _.keys(batteries).forEach(instance => {
      var path = `${batteriesPath}.${instance}`;
      if (this.noignoredPath(path)
            && !this.accessories.has(path) ) {

        this.log(`Preparing battery device ${JSON.stringify(batteries[instance])}`);
        var displayName = this.getName(path, `Battery ${instance}`);
        var devicetype = batteries[instance].capacity ? 'batterySOC' : 'battery';
        var manufacturer = "NMEA"; // FIXME: batteries[instance].manufacturer.name.value || "NMEA";
        var model = batteries[instance].capacity ? 'Battery SOC' : 'Battery'; // FIXME: batteries[instance].manufacturer.model.value || "Battery";

        this.addAccessory(displayName, instance, path, manufacturer, model, displayName, batteriesPath, devicetype);
      }
    });
  }
  this.log('Done');

  this.log("Adding chargers");
  var chargers = _.get(tree, inverterChargerPath);
  if ( chargers ) {
    _.keys(chargers).forEach(instance => {
      var path = `${inverterChargerPath}.${instance}`;
      if (this.noignoredPath(path)
            && !this.accessories.has(path) ) {

        var displayName = this.getName(path, `Charger ${instance}`);
        var devicetype = 'charger';
        var manufacturer = "NMEA"; // chargers[instance].manufacturer.name.value || "NMEA";
        var model = "Charger"; // chargers[instance].manufacturer.model.value || "Charger";

        this.addAccessory(displayName, instance, path, manufacturer, model, displayName, inverterChargerPath, devicetype);
      }
    });
  }
  this.log('Done');

  // Add engine data
  this.log("Adding engine data");
  engines.forEach(device => {
    var path = `${enginePath}.${device.key}`;
    var environment = _.get(tree, path);
    if ( environment
          && this.noignoredPath(path)
          && !this.accessories.has(path) ) {

      var displayName = this.getName(path, device.displayName);
      var devicetype = device.devicetype;
      var manufacturer = 'NMEA';
      var model = `${device.displayName} Sensor`;

      this.addAccessory(displayName, device.key, path, manufacturer, model, displayName, environmentPath, devicetype);
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
  return this.config.ignoredPaths.indexOf(path) == -1
}

// - - - - - - - Read and write Signal K API keys functions - - - - - - -

// Reads value for path from Signal K API
SignalKPlatform.prototype.getValue = function(path, cb, conversion) {
  var url = this.url + path.replace(/\./g, '/')
  // this.log(`GET ${url}`)
  let headers = {}

  if ( this.securityToken ) {
    headers['Authorization'] = 'JWT ' + this.securityToken
  }

  request({url: url,
           headers: headers},
          (error, response, body) => {
            if ( error ) {
//            this.log(`response: ${JSON.stringify(response)} body ${JSON.stringify(body)}`)
              cb(error, null)
            } else if ( response.statusCode == 404 ) {
//              this.log(`response: ${response.statusCode} ${response.request.method} ${response.request.uri.path}`)
              cb(new Error('device not present: 404'), null)  // removeAccessory relies on that error text
            } else if ( response.statusCode != 200 ) {
//              this.log(`response: ${response.statusCode} ${response.request.method} ${response.request.uri.path}`)
              cb(new Error(`invalid response ${response.statusCode}`), null)
            } else {
// this.log(`GET ${url}`)
// this.log(body, '>', conversion(body) );
              cb(null, conversion(body))
            }
          })
}

// Checks if device keys are still present
SignalKPlatform.prototype.checkKey = function(path, callback) {
  this.getValue(path, callback,
              (body) => body)
}

// Returns the value for path in %
SignalKPlatform.prototype.getRatio = function(path, callback) {
  this.getValue(path + '.value', callback,
                (body) =>  Number(body) * 100)
}

// Returns the state of path as boolean
SignalKPlatform.prototype.getOnOff = function(path, callback) {
  this.getValue(path + '.value', callback,
                (body) => (body == 'true') )
}

// Returns temperature in °C
SignalKPlatform.prototype.getTemperature = function(path, callback) {
  this.getValue(path + '.value', callback,
                (body) =>  Number(body) - 273.15)
}

const notChargingValues = [
  'not charging',
  'other',
  'off',
  'low power',
  'fault'
];

SignalKPlatform.prototype.getChargingState = function(path, callback)  {
  this.getValue(path + '.value', callback,
                (body) =>  {
                  return notChargingValues.indexOf(body) == -1 ? 1 : 0;
                })
}

SignalKPlatform.prototype.getStatusWarnBattery = function(path, batteryWarnCondition, callback) {
  this.getValue(path + '.value', callback, batteryWarnCondition)
}

SignalKPlatform.prototype.getStatusLowTank = function(path, tankWarnCondition, callback) {
  this.getValue(path + '.value', callback, tankWarnCondition)
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
              cb(error, null)     // FIXME: Error is not used
            } else if ( response.statusCode != 200 ) {
              this.log(`response: ${response.statusCode} ${response.request.method} ${response.request.uri.path}`)
              cb(new Error(`invalid response ${response.statusCode}`), null)     // FIXME: Error is not used
            } else {
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

  // Build WebSocket subscription string
  var subscriptionPaths = [];
  this.updateSubscriptions.forEach((subscription, key, map) => {
    subscriptionPaths.push({"path": key})
  });

  var subscriptionMessage = `{"context": "vessels.self","subscribe":${JSON.stringify(subscriptionPaths)}}`
  // platform.log(subscriptionMessage); // --

  this.ws.on('open', function open() {
    platform.ws.send(subscriptionMessage);
    platform.log('Subscription message sent');
  });

  this.ws.on('message', function incoming(data) {
    // debug('Incoming:',data);
    message = JSON.parse(data)

    if ( _.hasIn(message, 'updates') ) {
      latestUpdate = _.last(message.updates)  // We want to update to last status only
      latestValue = _.last(latestUpdate.values)
      valuePath = latestValue.path
      valueValue = latestValue.value

      targetList = platform.updateSubscriptions.get(valuePath)
      targetList.forEach(target => {
        target.characteristic.updateValue(target.conversion(valueValue));
        debug('Updating value:',target.conversion)
        if (valuePath.slice(0,empirBusIdentifier.length) == empirBusIdentifier) {
          platform.log('Updating value:', valuePath, '>', target.characteristic.displayName, '|', valueValue, '>', target.conversion(valueValue));
        }
      })
    } else {
      platform.log('Welcome message recieved');
    }

  });

};
