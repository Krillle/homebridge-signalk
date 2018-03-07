const _ = require('lodash');
var request = require('request');
var http = require('http');
var _url = require('url');
var websocket = require("ws");

var Accessory, Service, Characteristic, UUIDGen;

// EmpirBus:
//
// Key path according to EmpirBus Application Specific PGN Data Model 2 (2x word + 8x bit) per instance:
// 2x dimmer values 0 = off .. 1000 = 100%, 8x switch values 0 = off / 1 = on
//
// electrical.switches.empirBusNxt-instance<NXT component instance 0..49>-switch<#1..8>.state
// electrical.switches.empirBusNxt-instance<NXT component instance 0..49>-dimmer<#1..2>.state

const controlsPath = 'electrical.switches'
const empirBusIdentifier = 'empirBusNxt'
const putPath = '/plugins/signalk-empirbus-nxt/switches/'
const urlPath = 'signalk/v1/api/vessels/self/'
const wsPath = 'signalk/v1/stream?subscribe=none' // none will stream only the heartbeat, until the client issues subscribe messages in the WebSocket stream


// Environment temperatures + humidity:
//
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

// Batteries and chargers
const batteriesPath = 'electrical.batteries'
const inverterChargerPath = 'electrical.inverterCharger'


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
  var platform = this;
  this.log = log;
  this.config = config;
  this.accessories = new Map();

  this.updateSubscriptions = new Map (); // Devices to update on WebSocket

  this.url = 'http://' + config.host + '/' + urlPath;
  this.ws = 'ws://' + config.host + '/' + wsPath;


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
            if (error && error.message == 'device not present: 404' || !this.noignoredPath(accessory.context.path)) {
              platform.log(`${accessory.displayName} not present`);
              platform.removeAccessory(accessory);
            }
          })
        });

        // Addd new accessories in Signal K
        platform.log("Looking for new accessories");
        platform.autodetectNewAccessories()

        // Start accessories value updating
        platform.InitiateWebSocket()

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
      this.addBatteryServices(accessory);
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
  var uuid = UUIDGen.generate(accessoryName);

  this.log(`Add Accessory ${accessoryName}: ${path}, ${devicetype}`);

  var newAccessory = new Accessory(accessoryName, uuid);

  // Plugin can save context on accessory to help restore accessory in configureAccessory()
  newAccessory.context.identifier = identifier
  newAccessory.context.path = path
  newAccessory.context.categoryPath = categoryPath
  newAccessory.context.devicetype = devicetype
  newAccessory.context.manufacturer = manufacturer
  newAccessory.context.model = model
  newAccessory.context.serialnumber = serialnumber

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
      newAccessory.addService(Service.LeakSensor, accessoryName)
      this.addTankServices(newAccessory);
      break;
    case 'battery' || 'charger':
      newAccessory.addService(Service.BatteryService, accessoryName)
      this.addBatteryServices(newAccessory);
      break;
  }

  this.accessories.set(path, newAccessory);
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
    platform.setOnOff(accessory.context.identifier, false);
    setTimeout(()=>{platform.setOnOff(accessory.context.identifier, true), ()=> {console.log('FIXME: Device unreachable');} // FIXME: Device unreachable
                   }, 250);
    setTimeout(()=>{platform.setOnOff(accessory.context.identifier, false), ()=> {console.log('FIXME: Device unreachable');} // FIXME: Device unreachable
                   }, 750);
    // FIXME: Restore original state of device before cycle
    //  setTimeout(()=>{platform.setOnOff(identifier, stateBefore)}, 1000);

    callback();
  });

  // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
  accessory.getService(Service.Lightbulb)
  .getCharacteristic(Characteristic.On)
  .on('get', this.getOnOff.bind(this, accessory.context.path + '.state'))
  .on('set', function(value, callback) {
    platform.log(`Set dimmer ${accessory.displayName}.state to ${value}`)
    platform.setOnOff(accessory.context.identifier, value, ()=> {console.log('FIXME: Device unreachable');}) // FIXME: Device unreachable
    callback();
  })

  accessory.getService(Service.Lightbulb)
  .getCharacteristic(Characteristic.Brightness)
  .on('get', this.getRatio.bind(this, accessory.context.path + '.dimmingLevel'))
  .on('set', function(value, callback) {
    platform.log(`Set dimmer ${accessory.displayName}.Brightness to ${value}%`)
    platform.SetRatio(accessory.context.identifier, value, ()=> {console.log('FIXME: Device unreachable');}) // FIXME: Device unreachable
    callback();
  });

}

// Add services for Switch to existing accessory object
SignalKPlatform.prototype.addSwitchServices = function(accessory) {
  var platform = this;

  // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
  accessory.getService(Service.Switch)
  .getCharacteristic(Characteristic.On)
  .on('get', this.getOnOff.bind(this, accessory.context.path + '.state'))
  .on('set', function(value, callback) {
    platform.log(`Set switch ${accessory.displayName}.state to ${value}`)
    platform.setOnOff(accessory.context.identifier, value, ()=> {console.log('FIXME: Device unreachable');}) // FIXME: Device unreachable
    callback();
  });

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.Switch).getCharacteristic(Characteristic.On)
  subscription.conversion = (body) => body == true
  this.updateSubscriptions.set(accessory.context.path + '.state', subscription);
}

// Add services for Temperature Sensor to existing accessory object
SignalKPlatform.prototype.addTemperatureServices = function(accessory) {
  // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
  accessory.getService(Service.TemperatureSensor)
  .getCharacteristic(Characteristic.CurrentTemperature)
  .on('get', this.getTemperature.bind(this, accessory.context.path));

  subscription = new Object ();
  subscription.characteristic = accessory.getService(Service.TemperatureSensor).getCharacteristic(Characteristic.CurrentTemperature)
  subscription.conversion = (body) =>  Number(body) - 273.15
  this.updateSubscriptions.set(accessory.context.path, subscription);
}

// Add services for Humidity Sensor to existing accessory object
SignalKPlatform.prototype.addHumidityServices = function(accessory) {
  // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
  accessory.getService(Service.HumiditySensor)
  .getCharacteristic(Characteristic.CurrentRelativeHumidity)
  .on('get', this.getRatio.bind(this, accessory.context.path));
}

SignalKPlatform.prototype.addTankServices = function(accessory) {
  // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
  accessory.getService(Service.LeakSensor)
  .getCharacteristic(Characteristic.WaterLevel)
  .on('get', this.getRatio.bind(this, accessory.context.path));
}

SignalKPlatform.prototype.addBatteryServices = function(accessory) {
  // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.BatteryLevel)
  .on('get', this.getRatio.bind(this, accessory.context.path + '.capacity.stateOfCharge'));

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.ChargingState)
  .on('get', this.getChargingState.bind(this, accessory.context.path + '.chargingMode'));

  accessory.getService(Service.BatteryService)
  .getCharacteristic(Characteristic.StatusLowBattery)
  .on('get', this.getStatusLowBattery.bind(this, accessory.context.path + ".voltage"));
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
}

// - - - - - - - - - - - - - - - Signal K specific - - - - - - - - - - - - - -

// Autodetect Devices
// Autodetect from API all Dimmers, Switches
SignalKPlatform.prototype.autodetectNewAccessories = function() {
  this.log("Autodecting " + this.url);

  request(this.url,
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

  // Add electrical controls (EmpirBus NXT)
  this.log("Adding electrical controls (EmpirBus NXT)");
  var controls = _.get(tree, controlsPath);
  if ( controls ) {
    _.keys(controls).forEach(device => {

      if (device.slice(0,empirBusIdentifier.length) == empirBusIdentifier
            && this.noignoredPath(`${controlsPath}.${device}`)
            && !this.accessories.has(`${controlsPath}.${device}`) ) {
        var path = `${controlsPath}.${device}`;
        var fallbackName = controls[device].name.value || controls[device].meta.displayName.value ;
        var displayName = this.getName(path, fallbackName);
        var devicetype = controls[device].type.value;
        var manufacturer = controls[device].meta.manufacturer.name.value || "EmpirBus";
        var model = controls[device].meta.manufacturer.model.value || "NXT DCM";

        this.addAccessory(displayName, device, path, manufacturer, model, controls[device].name.value, controlsPath, devicetype);
        // updateSubscriptions.push(displayName, device, path);
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
      var model = `${device.displayName} Temperature Sensor`;

      this.addAccessory(displayName, device.key, path, manufacturer, model, displayName, environmentPath, devicetype);
      // updateSubscriptions.push(displayName, device, path);
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
          var manufacturer = "NMEA"; // chargers[instance].manufacturer.name.value || "NMEA";
          var model = tankType; // chargers[instance].manufacturer.model.value || "Charger";
          var deviceKey = `${tankType}.${instance}`

          this.addAccessory(displayName, deviceKey, path, manufacturer, model, deviceKey, controlsPath, deviceType);
          // updateSubscriptions.push(displayName, device, path);
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

        var displayName = this.getName(path, `Battery ${instance}`);
        var devicetype = 'battery';
        var manufacturer = "NMEA"; // batteries[instance].manufacturer.name.value || "NMEA";
        var model = "Battery"; // batteries[instance].manufacturer.model.value || "Battery";

        this.addAccessory(displayName, instance, path, manufacturer, model, displayName, controlsPath, devicetype);
        // updateSubscriptions.push(displayName, device, path);
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

        this.addAccessory(displayName, instance, path, manufacturer, model, displayName, controlsPath, devicetype);
        // updateSubscriptions.push(displayName, device, path);
      }
    });
  }
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
  request(url,
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

SignalKPlatform.prototype.getStatusLowBattery = function(path, callback) {
  this.getValue(path + '.value', callback,
                (body) =>  {
                  return Number(body) < 11.5;  // FIXME: Low battery voltage 23V
                })
}


// Writes value for path to Signal K API
SignalKPlatform.prototype.setValue = function(device, value, cb) {
  var url = _url.parse(this.url, true, true)
  url = `${url.protocol}//${url.host}${putPath}${device}/${value}`
  this.log(`PUT ${url}`)
  request({url: url,
           method: 'PUT'
          },
          (error, response, body) => {
            if ( error ) {
              this.log(`response: ${JSON.stringify(response)} body ${JSON.stringify(body)}`)
              cb(error, null)     // FIXME: Chrashes when Signal K not reachable. callback is missing
            } else if ( response.statusCode != 200 ) {
              this.log(`response: ${response.statusCode} ${response.request.method} ${response.request.uri.path}`)
              cb(new Error(`invalid response ${response.statusCode}`), null)
            } else {
//              cb(null, null)
            }
          })
}

// Set brightness of path as 0..1
SignalKPlatform.prototype.SetRatio = function(device, value, callback) {
  value = value / 100;
  this.setValue(device, value, callback);
}

// Set the state of path as boolean
SignalKPlatform.prototype.setOnOff = function(device, value, callback) {
  value = (value === true || value === "true") ? true : false;
  this.setValue(device, value, callback);
}

// - - - - - - - WebSocket Status Update- - - - - - - - - - - - - - - - - -

SignalKPlatform.prototype.InitiateWebSocket = function() {
// console.log('WebSocket URL: ' + this.ws);
  platform = this;
  const ws = new websocket(this.ws);

  // Build WebSocket subscription string
  var wsPaths = [];
  this.updateSubscriptions.forEach((subscription, key, map) => {
// console.log(key, '>', subscription.conversion);
    wsPaths.push({"path": key})
  });
  var subscriptionMessage = `{"context": "vessels.self","subscribe":${JSON.stringify(wsPaths)}}`

  console.log(subscriptionMessage);

  ws.on('open', function open() {
    ws.send(subscriptionMessage);
    console.log('subscriptionMessage sent');
  });

  ws.on('message', function incoming(data) {
    // console.log('>',data);
    message = JSON.parse(data)

    if ( _.hasIn(message, 'updates') ) {
      updateOne = _.first(message.updates)
      valueOne = _.first(updateOne.values)
      valuePath = valueOne.path
      valueValue = valueOne.value
      console.log(valuePath, '>', valueValue);

      target = platform.updateSubscriptions.get(valuePath)
      target.characteristic.updateValue(target.conversion(valueValue));
      console.log(valueOne.path, '|', valueValue, '>', target.conversion(valueValue));
      console.log('Check:',target.conversion(273.15))

    } else {
      console.log('Revieced Welcome');
    }

  });

};


// // - - - - - - - API Status polling - - - - - - -
//
// SignalKPlatform.prototype.InitiatePolling = function(pollUrl) {
//   console.log('Poll URL: ' + pollUrl);
//   var emitter = pollingtoevent(function(callback) {
//     request.get(pollUrl, function(err, req, data) {
//       callback(err, data);
//     });
//   }, {
//     longpolling:true
//   });
//
//   emitter.on("longpoll", function(data) {
//     console.log("longpoll emitted at %s, with data %j", Date.now());
//
//     var tree = JSON.parse(data);
//     console.log(_.get(tree, 'electrical.controls.empirBusNxt-instance0-switch7.state.value'))
//
//   });
//
//   // emitter.on("poll", function(data) {
//   //   console.log("Event emitted at %s, with data %j", Date.now(), data);
//   // });
//   //
//   emitter.on("error", function(err, data) {
//     console.log("Emitter errored: %s. with data %j", err, data);
//
//     // for (var accessory in this.accessories) {
//     //   accessory.reachable = false;
//     // }
//   });
// };

// ------------- legacy ---------------

// // Update accessories values
// SignalKPlatform.prototype.updateAccessoriesValues = function() {
//   this.log("Updating device values");
//
//   this.accessories.forEach((accessory, key, map) => {
//     // Update respective device value
//     switch(accessory.context.devicetype) {
//       case 'switch':
//         this.updateSwitchServices(accessory);
//         break;
//     }
//   });
// }
//
// // Update services of Switch accessory object
// SignalKPlatform.prototype.updateSwitchServices = function(accessory) {
//   // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
//   service = accessory.getService(Service.Switch)
//   characteristic = service.getCharacteristic(Characteristic.On)
//
//   this.getOnOff.bind(this, accessory.context.path + '.state',
//                       (err, newValue) => {
//                         if (error) {
//                           this.log(error)
//                         } else {
//                           service.updateCharacteristic(characteristic, newValue)
//                         }
//                       }
//   )
// };

//  updateSubscriptions.push(accessory, device, path);




    //
    // platform.checkKey(accessory.context.path, (error, result) => {
    //   if (error && error.message == 'device not present: 404') {
    //     platform.log(`${accessory.displayName} not present`);
    //     platform.removeAccessory(accessory);
    //   }
