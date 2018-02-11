const _ = require('lodash');
var request = require('request');
var http = require('http');
var _url = require('url');
var pollingtoevent = require("polling-to-event");

var Accessory, Service, Characteristic, UUIDGen;

// EmpirBus:
//
// Key path according to EmpirBus Application Specific PGN Data Model 2 (2x word + 8x bit) per instance:
// 2x dimmer values 0 = off .. 1000 = 100%, 8x switch values 0 = off / 1 = on
//
// electrical.controls.empirBusNxt-instance<NXT component instance 0..49>-switch<#0..7>.state
// electrical.controls.empirBusNxt-instance<NXT component instance 0..49>-dimmer<#0..1>.state

const controlsPath = 'electrical.controls'
const empirBusIdentifier = 'empirBusNxt'
const putPath = '/plugins/signalk-empirbus-nxt/controls/'

var updateSubscriptions = []; // Collects the devices to update in polling squence // FIXME


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
  this.accessories = [];

  this.url = ( config.url.charAt(config.url.length-1) == '/' ) ?
    config.url : config.url + '/'  // Append "/" to URL if missing

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
        // Remove not reachable accessories: cached accessories no more present in Signal K
        platform.log("Did finish launching, removing unreachable devices");
        console.log("check", this.accessories); // ---------------------------------------------------------------- <<<<<<<<<<

        _.keys(this.accessories).forEach(device => {
console.log("check", device); // ---------------------------------------------------------------- <<<<<<<<<<
console.log("check", this.accessories[device]); // ---------------------------------------------------------------- <<<<<<<<<<
          if (!this.accessories[device].reachable) {
            this.log(`Removing unreachable device ${this.accessories[device].displayName}`)
            this.removeAccessory(this.accessories[device]);
          }
        });

        // Addd new accessories in Signal K
        platform.log("Looking for new accessories");
        this.autodetectNewAccessories()
        // this.InitiatePolling(url + controlsPath.replace(/\./g, '/'))

      }.bind(this));
  }
}

// Function invoked when homebridge tries to restore cached accessory.
// Developer can configure accessory at here (like setup event handler).
// Update current value.
SignalKPlatform.prototype.configureAccessory = function(accessory) {
  this.log(accessory.displayName, "Configure Accessory");
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
  switch(accessory.context.devicetype) {
    case 'switch':
      this.addSwitchServices(accessory);
      break;
    case 'dimmer':
        this.addDimmerServices(accessory);
      break;
  }

  this.accessories.push(accessory);
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
  }

  this.accessories.push(newAccessory);
  this.api.registerPlatformAccessories("homebridge-signalk", "SignalK", [newAccessory]);
}

// Add services for Dimmer to existing accessory object
SignalKPlatform.prototype.addDimmerServices = function(accessory) {
  var platform = this;

  accessory.on('identify', function(paired, callback) {
    platform.log(`Identifying Dimmer Accessory ${accessory.displayName} by off/on/off cycle`);

    // FIXME: Get state before cycle
    // var stateBefore;
    // platform.getOnOff.bind(platform, path + '.state',(error,value)=> {stateBefore = value});
    // console.log(stateBefore);

    // Off/On/Off/Restore cycle
    platform.setOnOff(accessory.context.identifier, false);
    setTimeout(()=>{platform.setOnOff(accessory.context.identifier, true)}, 250);
    setTimeout(()=>{platform.setOnOff(accessory.context.identifier, false)}, 750);
    // FIXME: Restore state before cycle
    //  setTimeout(()=>{platform.setOnOff(identifier, stateBefore)}, 1000);

    callback();
  });

  // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
  accessory.getService(Service.Lightbulb)
  .getCharacteristic(Characteristic.On)
  .on('get', this.getOnOff.bind(this, accessory.context.path + '.state'))
  .on('set', function(value, callback) {
    platform.log(`Set dimmer ${accessory.displayName}.state to ${value}`)
    platform.setOnOff(accessory.context.identifier, value)
    callback();
  })

  accessory.getService(Service.Lightbulb)
  .getCharacteristic(Characteristic.Brightness)
  .on('get', this.getRatio.bind(this, accessory.context.path + '.state'))
  .on('set', function(value, callback) {
    platform.log(`Set dimmer ${accessory.displayName}.Brightness to ${value}%`)
    platform.SetRatio(accessory.context.identifier, value)
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
    platform.setOnOff(accessory.context.identifier, value)
    callback();
  });
}

// // Add Switch accessory
// SignalKPlatform.prototype.addSwitchAccessory = function(accessoryName, identifier, path, manufacturer, model, serialnumber, controlsPath, devicetype) {
//   var platform = this;
//   var uuid;
//
//   uuid = UUIDGen.generate(accessoryName);
//
//   this.log(`Add Switch Accessory ${accessoryName}: ${path}, ${uuid}`);
//
//   var newAccessory = new Accessory(accessoryName, uuid);
//   newAccessory.on('identify', function(paired, callback) {
//     platform.log(newAccessory.displayName, "Identify!");
//     callback();
//   });
//   // Plugin can save context on accessory to help restore accessory in configureAccessory()
//   newAccessory.context.identifier = identifier
//   newAccessory.context.path = path
//   newAccessory.context.manufacturer = manufacturer
//   newAccessory.context.model = model
//   newAccessory.context.serialnumber = serialnumber
//
//   // Add Device Information for EmpirBus NTX Dimmer
//   newAccessory.getService(Service.AccessoryInformation)
//     .setCharacteristic(Characteristic.Manufacturer, manufacturer)
//     .setCharacteristic(Characteristic.Model, model)
//     .setCharacteristic(Characteristic.SerialNumber, serialnumber);
//
//   // Make sure you provided a name for service, otherwise it may not visible in some HomeKit apps
//   newAccessory.addService(Service.Switch, accessoryName)
//   .getCharacteristic(Characteristic.On)
//   .on('get', this.getOnOff.bind(this, path + '.state'))
//   .on('set', function(value, callback) {
//     platform.log(`Set switch ${accessoryName}.state to ${value}`)
//     platform.setOnOff(identifier, value)
//     callback();
//   })
//
//   this.accessories.push(newAccessory);
//   this.api.registerPlatformAccessories("homebridge-signalk", "SignalK", [newAccessory]);
// }


SignalKPlatform.prototype.updateAccessoriesReachability = function() {
  this.log("Update Reachability");
  for (var index in this.accessories) {
    var accessory = this.accessories[index];
    accessory.updateReachability(false);
  }
}

// Remove accessory
SignalKPlatform.prototype.removeAccessory = function(accessory) {
  this.log('Remove accessory', accessory.displayName);
  this.api.unregisterPlatformAccessories("homebridge-signalk", "SignalK", [accessory]);

  _.remove(this.accessories, function(a) {
console.log(a.UUID, accessory.UUID); // ---------------------------------------------------------------- <<<<<<<<<<
    return a.UUID == accessory.UUID;
  });
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

  this.log("Adding electrical controls (EmpirBus NXT)");
  // Add electrical controls (EmpirBus NXT)
  var controls = _.get(tree, controlsPath);

  if ( controls ) {
    _.keys(controls).forEach(device => {

      if (device.slice(0,empirBusIdentifier.length) == empirBusIdentifier
            && this.noignoredPath(`${controlsPath}.${device}`)
            && typeof _.find(this.accessories, (entry) => entry.context.identifier == device) == 'undefined') {
        var path = `${controlsPath}.${device}`;
        var fallbackName = controls[device].name.value || controls[device].meta.displayName.value ;
        var displayName = this.getName(path, fallbackName);
        var devicetype = controls[device].type.value;
        var manufacturer = controls[device].manufacturer.name.value || "EmpirBus";
        var model = controls[device].manufacturer.model.value || "NXT DCM";

        this.addAccessory(displayName, device, path, manufacturer, model, controls[device].name.value, controlsPath, devicetype);
        // updateSubscriptions.push(displayName, device, path);

      }
    });
  }
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
  this.log(`GET ${url}`)
  request(url,
          (error, response, body) => {          // FIXME: Errorhandling crashes
            if ( error ) {
              this.log(`response: ${JSON.stringify(response)} body ${JSON.stringify(body)}`)
              cb(error, null)
            } else if ( response.statusCode != 200 ) {
              this.log(`response: ${response.statusCode} ${response.request.method} ${response.request.uri.path}`)
              cb(new Error(`invalid response ${response.statusCode}`), null)
            } else {
              cb(null, conversion(body))
            }
          })
}

// Returns the value for path in %
SignalKPlatform.prototype.getRatio = function(path, callback) {
  this.getValue(path + '.value', callback,
                (body) =>  Number(body) * 100)
}

// Returns the state of path as boolean
SignalKPlatform.prototype.getOnOff = function(path, callback) {
  this.getValue(path + '.value', callback,
                (body) => (body == '"on"') || (Number(body) > 0))
}

// Returns true if device keys are still present
SignalKPlatform.prototype.checkKey = function(path, callback) {
  this.getValue(path, callback,
              (body) => body)
}


// Writes value for path to Signal K API
SignalKPlatform.prototype.setValue = function(device, value, cb) {
  var url = _url.parse(this.url, true, true)
  url = `${url.protocol}//${url.host}${putPath}${device}/${value}`
  this.log(`PUT ${url}`)
  request({url: url,
           method: 'PUT'
          },
          (error, response, body) => {          // FIXME: Errorhandling crashes
            if ( error ) {
              this.log(`response: ${JSON.stringify(response)} body ${JSON.stringify(body)}`)
              cb(error, null)
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
  value = (value === true || value === "true") ? 'on' : 'off';
  this.setValue(device, value, callback);
}


// - - - - - - - API Status polling - - - - - - -

SignalKPlatform.prototype.InitiatePolling = function(pollUrl) {
  console.log('Poll URL: ' + pollUrl);
  emitter = pollingtoevent(function(callback) {
    request.get(pollUrl, function(err, req, data) {
      callback(err, data);
    });
  }, {
    longpolling:true
  });

  emitter.on("longpoll", function(data) {
    console.log("longpoll emitted at %s, with data %j", Date.now());
  });

  // emitter.on("poll", function(data) {
  //   console.log("Event emitted at %s, with data %j", Date.now(), data);
  // });
  //
  emitter.on("error", function(err, data) {
    console.log("Emitter errored: %s. with data %j", err, data);
  });
};


SignalKPlatform.prototype.manageValue = function(change) {
    for (let i = 0; i < this.platform.updateSubscriptions.length; i++) {
        let subscription = this.platform.updateSubscriptions[i];
        if (subscription.id == change.id && subscription.property == "value") {
            this.platform.log("Updating value for device: ", `${subscription.id}  parameter: ${subscription.characteristic.displayName}, value: ${change.value}`);
            let getFunction = this.platform.getFunctions.getFunctionsMapping.get(subscription.characteristic.UUID);
            if (getFunction)
                getFunction.call(this.platform.getFunctions, null, subscription.characteristic, subscription.service, null, change);
        }
    }
}
