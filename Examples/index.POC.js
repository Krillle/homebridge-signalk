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

var updateSubscriptions = []; // Collects the devices to update in polling squence


module.exports = function(homebridge) {
  console.log("homebridge API version: " + homebridge.version);

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
  this.api = api;

  if (api) {
      // Save the API object as plugin needs to register new accessory via this object
      this.api = api;

      // Listen to event "didFinishLaunching", this means homebridge already finished loading cached accessories.
      // Platform Plugin should only register new accessory that doesn't exist in homebridge after this event.
      // Or start discover new accessories.
      this.api.on('didFinishLaunching', function() {
        platform.log("DidFinishLaunching");
      }.bind(this));
  }
}


// SignalKAccessory definition

function SignalKAccessory(log, url, config, name) {
  this.log = log;
  this.name = name;
  this.config = config;
  this.url = url;
}

// Services definition

SignalKAccessory.prototype.getServices = function(callback) {
  return this.services
}

//
// Accessories definition
// Autodetect from API all Dimmers, Switches

SignalKPlatform.prototype.accessories = function(callback) {
  this.url = this.config.url
  if ( this.url.charAt(this.url.length-1) != '/' )   // Append "/" to URL if missing
    this.url = this.url + '/'

  var informationService = new Service.AccessoryInformation();

  //  Supposed to be characteristic of each single accessory.
  //  FIXME: Especially SerialNumber supposed to be UUID
  informationService
    .setCharacteristic(Characteristic.Manufacturer, "EmpirBus")
    .setCharacteristic(Characteristic.Model, "DCU")
    .setCharacteristic(Characteristic.SerialNumber, 'GLW46003E212');


  var ThisAccessory = new SignalKAccessory(this.log, this.url, this.config, "Noname")

  ThisAccessory.autoDetect(this.url, (error, services) => {
    if ( error ) {
      this.log(`error: ${error}`);
      callback([]);
    } else {
      services.push(informationService);
      ThisAccessory.services = services;
      callback([ThisAccessory])
    }
  });
}

// - - - - - - - Autodetect Devices - - - - - - -

SignalKAccessory.prototype.autoDetect = function(url, callback) {
  this.log("Starting autodetect");
  request(url,
          (error, response, body) => {
            if ( error ) {
              callback(error);
            } else if ( response.statusCode != 200 ) {
              callback(new Error(`response code ${response.statusCode}`))
            } else {
              this.processFullTree(body, callback);
              this.InitiatePolling(url + controlsPath.replace(/\./g, '/'))
            }
          })
}

// Lookup full API Keys tree for HomeKit suitable devices
SignalKAccessory.prototype.processFullTree = function(body, callback) {

  console.log("Check:",this.log, this.url, this.config, "Noname");


  var tree = JSON.parse(body);
  var services = []

  // Add electrical controls (EmpirBus NXT)
  var controls = _.get(tree, controlsPath);

  if ( controls ) {
    _.keys(controls).forEach(device => {

      if ((device.slice(0,empirBusIdentifier.length)) == empirBusIdentifier ) {
        var path = `${controlsPath}.${device}`;
        var fallbackName = controls[device].name.value || controls[device].meta.displayName.value ;
        var displayName = this.getName(path, fallbackName);
        var devicetype = controls[device].type.value;

        switch(devicetype) {
          case 'switch':
            services.push(this.addSwitchService(displayName, device, path));
            updateSubscriptions.push(displayName, device, path);
            break;
          case 'dimmer':
            services.push(this.addLightbulbService(displayName, device, path));
            updateSubscriptions.push(displayName, device, path);
          break;
        }
      }
    });
  }
  callback(null, services.filter(service => service != null))
}


// - - - - - - - Add Services - - - - - - -

SignalKAccessory.prototype.addLightbulbService = function(name, subtype, path) {
  if ( !this.checkPath(path) ) {
    return null;
  }
  this.log(`Add lightbulb "${name}": ${subtype}, ${path}`)
  var service = new Service.Lightbulb(name, subtype)

  var that = this
  service.getCharacteristic(Characteristic.On)
    .on('get', this.getOnOff.bind(this, path + '.state'))
    .on('set', function(value, callback) {
      that.log(`Set dimmer ${name}.state to ${value}`)
      that.setOnOff(subtype, value)
      callback();
    });

    service.getCharacteristic(Characteristic.Brightness)
      .on('get', this.getRatio.bind(this, path + '.state'))
      .on('set', function(value, callback) {
        that.log(`Set dimmer ${name}.Brightness to ${value}`)
        that.SetRatio(subtype, value)
        callback();
      });

  service.setCharacteristic(Characteristic.Name, name);

  return service;
}


SignalKAccessory.prototype.addSwitchService = function(name, subtype, path) {
  if ( !this.checkPath(path) ) {
    return null;
  }
  this.log(`Add switch "${name}": ${subtype}, ${path}`)
  var service = new Service.Switch(name, subtype)

  var that = this
  service.getCharacteristic(Characteristic.On)
    .on('get', this.getOnOff.bind(this, path + '.state'))
    .on('set', function(value, callback) {
      that.log(`Set switch ${name}.state to ${value}`)
      that.setOnOff(subtype, value)
      callback();
    });
  service.setCharacteristic(Characteristic.Name, name);

  return service;
}

// - - - - - - - Read and write keys functions - - - - - - -

// Returns true if path is not an ignored path in config.json
SignalKAccessory.prototype.checkPath = function(path) {
  return this.config.ignoredPaths.indexOf(path) == -1
}

// Returns a potential displayName from config.json
SignalKAccessory.prototype.getName = function(path, defaultName) {
  return (this.config.displayNames && this.config.displayNames[path]) || defaultName
}


// Reads value for path from Signal K API
SignalKAccessory.prototype.getValue = function(path, cb, conversion) {
  var url = this.url + path.replace(/\./g, '/')
  this.log(`GET ${url}`)
  request(url,
          (error, response, body) => {
//            this.log(`response: ${JSON.stringify(response)} body ${JSON.stringify(body)}`)
            this.log(`response: ${body} ${response.statusCode} ${response.request.method} ${response.request.uri.path}`)
            if ( error ) {
              cb(error, null)
            } else if ( response.statusCode != 200 ) {
              cb(new Error(`invalid response ${response.statusCode}`))
            } else {
              cb(null, conversion(body))
            }
          })
}

// Returns the value for path in %
SignalKAccessory.prototype.getRatio = function(path, callback) {
  this.getValue(path + '.value', callback,
                (body) =>  Number(body) * 100)
}

// Returns the state of path as boolean
SignalKAccessory.prototype.getOnOff = function(path, callback) {
  this.getValue(path + '.value', callback,
                (body) => (body == '"on"') || (Number(body) > 0))
}


// Writes value for path to Signal K API
SignalKAccessory.prototype.setValue = function(device, value, cb) {
  var url = _url.parse(this.url, true, true)
  url = `${url.protocol}//${url.host}${putPath}${device}/${value}`
  this.log(`PUT ${url}`)
  request({url: url,
           method: 'PUT'
          },
          (error, response, body) => {
//            this.log(`response: ${JSON.stringify(response)} body ${JSON.stringify(body)}`)
            this.log(`response: ${response.statusCode} ${response.request.method} ${response.request.uri.path}`)
            if ( error ) {
              cb(error, null)
            } else if ( response.statusCode != 200 ) {
              cb(new Error(`invalid response ${response.statusCode}`))
            } else {
//              cb(null, null)
            }
          })
}

// Set brightness of path as 0..1
SignalKAccessory.prototype.SetRatio = function(device, value, callback) {
  value = value / 100;
  this.setValue(device, value, callback);
}

// Set the state of path as boolean
SignalKAccessory.prototype.setOnOff = function(device, value, callback) {
  value = (value === true || value === "true") ? 'on' : 'off';
  this.setValue(device, value, callback);
}


// - - - - - - - API Status polling - - - - - - -

SignalKAccessory.prototype.InitiatePolling = function(pollUrl) {
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


SignalKAccessory.prototype.manageValue = function(change) {
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
