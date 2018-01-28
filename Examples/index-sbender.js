const http = require('http');
const _ = require('lodash');
var Accessory, Service, Characteristic, UUIDGen;

var request = require('request');

module.exports = function(homebridge) {
  console.log("homebridge API version: " + homebridge.version);

  Accessory = homebridge.platformAccessory;

  // Service and Characteristic are from hap-nodejs
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;

  // For platform plugin to be considered as dynamic platform plugin,
  // registerPlatform(pluginName, platformName, constructor, dynamic), dynamic must be true
  homebridge.registerPlatform("homebridge-platform-signalk", "SignalK", SKPlatform, true);
}

// Platform constructor
// config may be null
// api may be null if launched from old homebridge version
function SKPlatform(log, config, api) {
  log("SKPlatform Init");
  var platform = this;
  this.log = log;
  this.config = config;
}

SKPlatform.prototype.accessories = function(callback) {
  this.url = this.config.url
  if ( this.url.charAt(this.url.length-1) != '/' )
    this.url = this.url + '/'
  var battery = new SignalKAccessory(this.log, this.url, this.config, "Wilhelm")


  /*
  services.push(this.addBatteryService('House Battery', 'house', 'electrical/batteries/260'))
  services.push(this.addBatteryService('Bus Battery', 'bus', 'electrical/inverterCharger/261'))
  services.push(this.addTemperatureService('Cabin', 'environment/inside/temperature'))
  services.push(this.addHumidityService('Cabin', 'environment/inside/humidity'))
  services.push(this.addTankService('Diesel', 'fuel', 'tanks/fuel/0'))
  services.push(this.addTankService('Black Water', 'blackWater', 'tanks/blackWater/0'))
  services.push(this.addTankService('Fresh Water', 'freshWater', 'tanks/freshWater/0'))
  */

  var informationService = new Service.AccessoryInformation();
  informationService.setCharacteristic(Characteristic.Manufacturer, "Catalina")
  informationService.setCharacteristic(Characteristic.Model, "Cat 30")
  informationService.setCharacteristic(Characteristic.SerialNumber, '333323232')

  battery.autoDetect(this.url, (error, services) => {
    if ( error ) {
      this.log(`error: ${error}`);
      callback([]);
    } else {
      services.push(informationService);
      battery.services = services;
      callback([battery])
    }
  });
}

function SignalKAccessory(log, url, config, name) {

  this.log = log;
  //this.accessory = new Accessory(name, UUIDGen.generate(path));;
  this.name = name;
  this.config = config;
  this.url = url;

  //this.service = this.accessory.addService(Service.BatteryService, name)

  //this.accessory.getService(Service.AccessoryInformation)
}

SignalKAccessory.prototype.checkPath = function(path) {
  return this.config.ignoredPaths.indexOf(path) == -1
}

SignalKAccessory.prototype.getValue = function(path, cb, conversion) {
  var url = this.url + path.replace(/\./g, '/')
  this.log(`url ${url}`)
  request(url,
          (error, response, body) => {
            this.log(`response: ${JSON.stringify(response)} body ${JSON.stringify(body)}`)
            if ( error ) {
              cb(error, null)
            } else if ( response.statusCode != 200 ) {
              cb(new Error(`invalid response ${response.statusCode}`))
            } else {
              cb(null, conversion(body))
            }
          })
}

SignalKAccessory.prototype.getRatio = function(path, callback) {
  this.getValue(path + '.value', callback,
                (body) =>  Number(body) * 100)
}

const notChargingValues = [
  'not charging',
  'other',
  'off',
  'low power',
  'fault'
];

SignalKAccessory.prototype.getChargingState = function(path, callback)  {
  this.getValue(path + '.value', callback,
                (body) =>  {
                  return notChargingValues.indexOf(body) == -1 ? 1 : 0;
                })
}

SignalKAccessory.prototype.getStatusLowBattery = function(path, callback) {
  this.getValue(path + '.value', callback,
                (body) =>  {
                  return Number(body) < 11.5;
                })
}

SignalKAccessory.prototype.getAnchor = function(callback) {
  var url = this.url + 'navigation/anchor/position/value'

  request(url,
          (error, response, body) => {
            this.log(`response: ${JSON.stringify(response)} body ${JSON.stringify(body)}`)
            if ( error ) {
              callback(error, null)
            } else if ( response.statusCode == 404 ) {
              callback(null, false);
            } else if ( response.statusCode != 200 ) {
              callback(new Error(`invalid response ${response.statusCode}`))
            } else {
              var position = JSON.parse(body);
              callback(null, position != null && position.longitude != null)
              /*
              var this.url + 'navigation/anchor/maxRadius/value'
              request(url,
                      (error, response, body) => {
                        this.log(`response: ${JSON.stringify(response)} body ${JSON.stringify(body)}`)
                        if ( error ) {
                          callback(error, null)
                        } else if ( response.statusCode != 200 ) {
                          callback(new Error(`invalid response ${response.statusCode}`))
                        } else {
                          var maxRadius = JSON.parse(body)

                          cb(null, conversion(body))
                        }
                      });
              */
            }
          })
}


SignalKAccessory.prototype.getServices = function(callback) {
  return this.services
}

SignalKAccessory.prototype.addBatteryService = function(name, subtype, path) {
  if ( !this.checkPath(path) ) {
    return null;
  }
  this.log(`add battery ${name} ${subtype} ${path}`)
  var service = new Service.BatteryService(name, subtype)

  service.getCharacteristic(Characteristic.BatteryLevel)
    .on('get', this.getRatio.bind(this, path + '.capacity.stateOfCharge'));
  service.getCharacteristic(Characteristic.ChargingState)
    .on('get', this.getChargingState.bind(this, path + '.chargingMode'));
  service.getCharacteristic(Characteristic.StatusLowBattery)
    .on('get', this.getStatusLowBattery.bind(this, path + ".voltage"));

  service.setCharacteristic(Characteristic.Name, name);

  return service;
}

SignalKAccessory.prototype.getTemperature = function(path, callback) {
  this.getValue(path + '/value', callback,
                (body) =>  Number(body) - 273.15)
}

SignalKAccessory.prototype.addTemperatureService = function(name, subtype, path) {
  if ( !this.checkPath(path) ) {
    return null;
  }
  this.log(`add temperature ${name} ${subtype} ${path}`)
  var service = new Service.TemperatureSensor(name, subtype)

  service.getCharacteristic(Characteristic.CurrentTemperature)
    .on('get', this.getTemperature.bind(this, path));

  service.setCharacteristic(Characteristic.Name, name);
  service.setCharacteristic(Characteristic.StatusActive, 1);

  return service;
}

SignalKAccessory.prototype.addHumidityService = function(name, subtype, path) {
  if ( !this.checkPath(path) ) {
    return null;
  }
  this.log(`add humidity ${name} ${subtype} ${path}`)
  var service = new Service.HumiditySensor(name, subtype)

  service.getCharacteristic(Characteristic.CurrentRelativeHumidity)
    .on('get', this.getRatio.bind(this, path));

  service.setCharacteristic(Characteristic.Name, name);

  return service;
}

SignalKAccessory.prototype.addTankService = function(name, subtype, path) {
  if ( !this.checkPath(path) ) {
    return null;
  }
  this.log(`add tank ${name} ${subtype} ${path}`)
  var service = new Service.Lightbulb(name, subtype)

  service.getCharacteristic(Characteristic.Brightness)
    .on('get', this.getRatio.bind(this, path + '.currentLevel'));

  service.setCharacteristic(Characteristic.On, 1);
  service.setCharacteristic(Characteristic.Name, name);

  return service;
}

SignalKAccessory.prototype.addAnchorService = function() {
  this.log('add anchor alarm')
  var name = "Anchor Alarm"
  var service = new Service.Lightbulb(name, 'anchor')

  var that = this
  service.getCharacteristic(Characteristic.On)
    .on('get', this.getAnchor.bind(this))
    .on('set', function(value, callback) {
      that.log(`set anchor ${value}`)
      callback();
    });

  service.setCharacteristic(Characteristic.Name, name);

  return service;
}

SignalKAccessory.prototype.autoDetect = function(url, callback)
{
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

SignalKAccessory.prototype.getName = function(path, defaultName) {
  return (this.config.displayNames && this.config.displayNames[path]) || defaultName
}

SignalKAccessory.prototype.processFullTree = function(body, callback) {
  var tree = JSON.parse(body);

  var services = []

 // services.push(this.addAnchorService());

  var switches = _.get(tree, 'electrical.empirBusNxt');
  log("Switches")
  log(switches);
  if ( switches ) {
    _.keys(switches).forEach(instance => {
      _.keys(switches[instance]).forEach(element => {
        var path = `electrical.empirBusNxt.${instance}.switches.${element}`;
        var displayName = this.getName(path, `Component ${instance} Switch ${element}`)
//        services.push(this.addSwitchService(displayName, `${instance}.${element}`, path))
log (this.addSwitchService(displayName, `${instance}.${element}`, path))
      })
    });
  }

  var batteries = _.get(tree, 'electrical.batteries');
  if ( batteries ) {
    _.keys(batteries).forEach(instance => {
      var path = `electrical.batteries.${instance}`
      var displayName = this.getName(path, `Battery ${instance}`);

      services.push(this.addBatteryService(displayName, `battery.${instance}`, path))
    });
  }

  var chargers = _.get(tree, 'electrical.inverterCharger')
  if ( chargers ) {
    _.keys(chargers).forEach(instance => {
      var path = `electrical.inverterCharger.${instance}`
      var displayName = this.getName(path, `Charger ${instance}`);
      services.push(this.addBatteryService(displayName, `charger.${instance}`, path))
    });
  }

  ['inside', 'outside', 'water'].forEach(root => {

    var temp = _.get(tree, `environment.${root}.temperature`);
    if ( temp ) {
      var path = `environment.${root}.temperature`
      var displayName = _.get(temp, "meta.displayName") || this.getName(path, root)
      services.push(this.addTemperatureService(displayName, root, path))
    }

    var humidity = _.get(tree, `environment.${root}.humidity`);
    if ( humidity ) {
      var path = `environment.${root}.humidity`
      var displayName = _.get(humidity, "meta.displayName") || this.getName(path, root)
      services.push(this.addHumidityService(displayName, root, path))
    }
  });

  var tanks = _.get(tree, 'tanks');
  if ( tanks ) {
    _.keys(tanks).forEach(type => {
      _.keys(tanks[type]).forEach(instance => {
        var path = `tanks.${type}.${instance}`;
        var displayName = _.get(instance, "meta.displayName") || this.getName(path, type)
        services.push(this.addTankService(displayName, `${type}.${instance}`,  path))
      })
    });
  }
  callback(null, services.filter(service => service != null))
}
