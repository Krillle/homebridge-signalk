const _ = require('lodash');
var request = require('request');
var http = require('http');
var url = require('url');

var Accessory, Service, Characteristic, UUIDGen; 

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
}

//
// Accessories definition
// Autodetect from API all Dimmers, Switches 

SignalKPlatform.prototype.accessories = function(callback) {
console.log("prototype.accessories");
  this.url = this.config.url
  if ( this.url.charAt(this.url.length-1) != '/' )   // Append "/" to URL if missing
    this.url = this.url + '/'
    
  var informationService = new Service.AccessoryInformation();
  //  informationService
  //  .setCharacteristic(Characteristic.Manufacturer, "Linskens")
  //  .setCharacteristic(Characteristic.Model, "Catfish 46")
  //  .setCharacteristic(Characteristic.SerialNumber, 'NL-GLW46003E212');	

  //  Supposed to be characteristic of each single accessory. 
  //  FIXME: Especially SerialNumber supposed to be UUID 
  informationService
    .setCharacteristic(Characteristic.Manufacturer, "EmpirBus")
    .setCharacteristic(Characteristic.Model, "DCU")
    .setCharacteristic(Characteristic.SerialNumber, 'GLW46003E212');	
    

  var dimmer = new SignalKAccessory(this.log, this.url, this.config, "Noname")
 
  dimmer.autoDetect(this.url, (error, services) => {
    if ( error ) {
      this.log(`error: ${error}`);
      callback([]);
    } else {
      services.push(informationService);
      dimmer.services = services;
      callback([dimmer])
    }
  });
}


function SignalKAccessory(log, url, config, name) {
console.log("SignalKAccessory");
  this.log = log;
  this.name = name;
  this.config = config;
  this.url = url;

}

// - - - - - - - Helper functions - - - - - - -

SignalKAccessory.prototype.autoDetect = function(url, callback) {
console.log("Autodetect");
  request(url,
          (error, response, body) => {
            if ( error ) {
              callback(error);
            } else if ( response.statusCode != 200 ) {
              callback(new Error(`response code ${response.statusCode}`))
            } else {
              this.processFullTree(body, callback);
            }
          })
}


SignalKAccessory.prototype.checkPath = function(path) {
  return this.config.ignoredPaths.indexOf(path) == -1
}


SignalKAccessory.prototype.getName = function(path, defaultName) {
  return (this.config.displayNames && this.config.displayNames[path]) || defaultName
}


// Lookup full API Keys tree for HomeKit suitable devices
SignalKAccessory.prototype.processFullTree = function(body, callback) {
  console.log("Processing Tree Start");
  console.log(body);
  
  var tree = JSON.parse(body);
  var services = []

  var switches = _.get(tree, 'electrical.empirBusNxt');
  console.log("Switches")
  console.log(switches);
  if ( switches ) {
    _.keys(switches).forEach(instance => {
      _.keys(switches[instance]).forEach(element => {
        var path = `electrical.empirBusNxt.${instance}.switches.${element}`;
        var displayName = this.getName(path, `Component ${instance} Switch ${element}`)
//        services.push(this.addSwitchService(displayName, `${instance}.${element}`, path))
console.log (displayName, `${instance}.${element}`, path)
      })
    });
  }
  callback(null, services.filter(service => service != null))
}

