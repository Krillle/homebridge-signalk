var request = require("request");
var moment = require('moment');
var util = require('util');
var Service, Characteristic, LastUpdate;

'use strict';

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerPlatform("homebridge-platform-insteon", "Insteon", InsteonPlatform);

    LastUpdate = function() {
        var self = this;

       Characteristic.call(self, 'Last Activity', '');

       self.setProps({
           format: Characteristic.Formats.STRING,
           perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
       });

        self.value = self.getDefaultValue();
    };
    require('util').inherits(LastUpdate, Characteristic);
}
function InsteonPlatform(log, config) {
    var self = this;
    self.config = config;
    self.log = log;
    self.host = 'https://connect.insteon.com'
    self.refreshInterval = 30 * 1000;
    self.apikey = 'APIKey ' + self.config['client_id'];
}
InsteonPlatform.prototype.login = function(onSuccess, onFail) {
    var self = this;
    var fbody = "grant_type=password&username=" + self.config['user'] + "&password=" + self.config['pass']
        + "&client_id=" + self.config['client_id'];
    request.post({
        url : self.host + '/api/v2/oauth2/token',
        body : fbody,
        headers: {
          "Content-Type" : "application/x-www-form-urlencoded"
        }
    }, function (error, response, body) {
        if (!error && response.statusCode == 200) {
            if (body.ReturnCode !== '0') {
                if(onFail) {
                    onFail.call(self, body.ReturnCode, body.ErrorMessage);
                } else {
                    self.retry_login.call(self, onSuccess);
                }
            } else if(onSuccess) {
                var jsonObj = JSON.parse(body);
                self.SecurityToken = jsonObj.access_token;
                self.log.debug('SecurityToken: [%s]', self.SecurityToken);
            }
        }
        else {
            self.log.error('[%s]: Error while login', moment().format('YYYYMMDDHHmmss.SSS'));
            self.log.error(error);
            self.log.error(response);
            self.log.error(body)
            if(!body) {
                body = {};
            }
            if(onFail) {
                onFail.call(self, body.ReturnCode, body.ErrorMessage);
            } else {
                self.retry_login.call(self, onSuccess);
            }
        }
    });
}
InsteonPlatform.prototype.retry_login = function(onSuccess) {
    var self = this;
    self.log.warn('[%s]:retrying login.', moment().format('YYYYMMDDHHmmss.SSS'));

    self.login(onSuccess, function(returnCode, errorMessage) {
        setTimeout(function() {
            self.retry_login.call(self, onSuccess);
        }.bind(self), self.refreshInterval);
    });
}

InsteonPlatform.prototype.getDevices = function(onSuccess, onFail) {
    var self = this;
    self.log.debug('[%s]: retrieving devices', moment().format('YYYYMMDDHHmmss.SSS'));
    if(!self.SecurityToken && onFail) {
        onFail.call(self);
        return;
    }
    request.get({
        var authtoken = "Bearer " + self.SecurityToken;

        url : self.host + '/api/v2/devices?properties=all',
        headers : {
          "Content-Type" : "application/json",
  				"Authentication" : self.apikey,
  				"Authorization" : authtoken
        }
    }, function (error, response, body) {
        if (!error && response.statusCode == 200) {
            var json = JSON.parse(body);
                if(json.DeviceList && json.DeviceList.length > 0) {
                    var insteon_devices = [];
                    json.DeviceList.forEach(function(device) {
                            insteon_devices.push(device);
                        }
                    })
                    onSuccess.call(self, insteon_devices);
                } else if(onFail) {
                  onFail.call(self, error, response);
                } else {
                  self.retry_login(onSuccess);
                }
        } else if(onFail) {
            onFail.call(self, error, response);
        } else {
            self.retry_login(onSuccess);
        }
    });
}

InsteonPlatform.prototype.sendCommand = function(level, device_id, state, callback) {
    var self = this;
    var authtoken = "Bearer " + self.SecurityToken;

    request.post({
        url : self.host + '/api/v2/commands',
        headers : {
          "Content-Type" : "application/json",
  				"Authentication" : self.apikey,
  				"Authorization" : authtoken
        },
        json : {
            command : state,
            level : level,
            device_id: device_id
        }
    }, function (error, response, body) {
        if (!error && response.statusCode == 200 && body.ReturnCode === '0') {
            self.log.info('[%s]: send command successed, level=[%s],state=[%s]', moment().format('YYYYMMDDHHmmss.SSS'), level, state);
            callback(body);
        } else {
            self.log.error('[%s]: send command failed.', moment().format('YYYYMMDDHHmmss.SSS'));
            self.log.error(error);
            self.log.error(response);
            self.log.error(body);
        }
    });
}
InsteonPlatform.prototype.dimmer_on = function(device_id, callback) {
    var self = this;
    self.sendCommand.call(self, '100', device_id, 'on', callback);
}
InsteonPlatform.prototype.dimmer_off = function(device_id, callback) {
    var self = this;
    self.sendCommand.call(self, '0', device_id, 'off', callback);
}
InsteonPlatform.prototype.dimmer_status = function(device_id, callback) {
    var self = this;
    self.sendCommand.call(self, '0', device_id, 'get_status', callback);
}

InsteonPlatform.prototype.accessories = function(callback) {
    var self = this;
    self.login.call(self, function() {
        self.getDevices.call(self, function(insteon_devices) {
            self.foundAccessories = [];
            insteon_devices.forEach(function(device) {
                self.foundAccessories.push(new InsteonAccessory(self, device));
            });
            callback(self.foundAccessories);
            self.timer = setTimeout(self.deviceStateTimer.bind(self), self.refreshInterval);
        }, function(returnCode, errorMessage) {
            self.log.error('[%s]:Insteon Server error when list accessories, returncode=[%s], errormessage=[%s]', moment().format('YYYYMMDDHHmmss.SSS'), returnCode, errorMessage);
            throw new Error("homebridge-platform-insteon has intentially brought down HomeBridge - please restart!");
        });
    }, function(returnCode, errorMessage) {
        self.log.error('[%s]:Insteon Server error, returncode=[%s], errormessage=[%s]', moment().format('YYYYMMDDHHmmss.SSS'), returnCode, errorMessage);
        throw new Error("homebridge-platform-insteon has intentially brought down HomeBridge - please fix your configuration!");
    });
}
InsteonPlatform.prototype.deviceStateTimer = function() {
    var self = this;
    if(self.timer) {
        clearTimeout(self.timer);
        self.timer = null;
    }
    self.getDevices(function(insteon_devices) {
        self.foundAccessories.forEach(function(accessory) {
            accessory.updateDevice(insteon_devices);
        });
        self.timer = setTimeout(self.deviceStateTimer.bind(self), self.refreshInterval);
    });
}

InsteonPlatform.prototype.dateTimeToDisplay = function(unixtime) {
    return moment(unixtime, 'x').fromNow()
}

function InsteonAccessory(platform, device) {
    var self = this;
    platform.log.debug(device);
    self.init.call(self, platform, device)
}
InsteonAccessory.prototype.init = function(platform, device) {
    var self = this;

    self.platform = platform;
    self.log = platform.log;
    self.currentState = '';
    self.name = device.InsteonID;
    self.updateDevice([device]);
}

InsteonAccessory.prototype.descState = function(state) {
    switch(state) {
        case Characteristic.CurrentDimmerState.ON:
        return 'on';
        case Characteristic.CurrentDimmerState.OFF:
        return 'off';
        default:
        return state;
    }
}

InsteonAccessory.prototype.updateDevice = function(devices) {
    var self = this;
    var isMe = false;
    if(!devices) {
        return false;
    }
    for(var i=0; i< devices.length; i++){
        if(!self.device || self.device.DeviceID === devices[i].DeviceID) {
            self.device = devices[i];
            isMe = true;
            break;
        }
    }
    if(!isMe || !self.device) {
        return false;
    }
    return true;
}

InsteonAccessory.prototype.getServices = function() {
    var self = this;
    var services = [];
    var service = new Service.AccessoryInformation();
    service.setCharacteristic(Characteristic.Name, self.DeviceName)
        .setCharacteristic(Characteristic.Manufacturer, 'Insteon')
        .setCharacteristic(Characteristic.Model, 'Insteon')
        .setCharacteristic(Characteristic.SerialNumber, self.SerialNumber || '')
        .setCharacteristic(Characteristic.FirmwareRevision, self.FirmwareVersion || '')
        .setCharacteristic(Characteristic.HardwareRevision, '');
    services.push(service);
    if(self.service) {
        services.push(self.service);
    }
    return services;
}

function InsteonAccessory(platform, device) {
    InsteonAccessory.call(this, platform, device);
    var self = this;
    self.log.info('[%s]: found Insteon Device, deviceid=%s', moment().format('YYYYMMDDHHmmss.SSS'), self.DeviceID);
}

function InsteonDimmerAccessory(platform, device) {
    InsteonAccessory.call(this, platform, device);
    var self = this;
    self.log.info('[%s]: found Dimmer Device, deviceid=%s', moment().format('YYYYMMDDHHmmss.SSS'), self.DeviceID);
}
util.inherits(InsteonDimmerAccessory, InsteonAccessory);

InsteonDimmerAccessory.prototype.init = function(platform, device) {
    var self = this;
    self.service = new Service.Switch(self.DeviceName);
    self.service.addCharacteristic(LastUpdate);
    InsteonDimmerAccessory.super_.prototype.init.call(self, platform, device);

    self.service.getCharacteristic(Characteristic.On).value = '';
    self.service.getCharacteristic(Characteristic.Name).value = self.DeviceName;
    self.service.getCharacteristic(LastUpdate).value = self.platform.dateTimeToDisplay(self.stateUpdatedTime);

    self.service.getCharacteristic(LastUpdate).on('get', function(cb) {
        cb(null, self.platform.dateTimeToDisplay(self.stateUpdatedTime));
    }.bind(self));

    self.service
        .getCharacteristic(Characteristic.On)
        .on('get', function(callback) {
            self.log.debug("[%s]: Getting current dimmer state...", moment().format('YYYYMMDDHHmmss.SSS'));
            self.platform['dimmer_status'].call(self.platform, self.DeviceID, function(body){
                self.log.debug(body);
                var json = JSON.parse(body);
                if (json.status != "succeeded") {
                  self.currentState = "off";
                } else {
                  if(json.response.level) {
                    self.currentState = "on";
                  } else {
                    self.currentState = "off";
                  }
                }
                self.stateUpdatedTime = moment().format('x');
                self.service.getCharacteristic(Characteristic.On).setValue(self.currentState);
                self.service.getCharacteristic(LastUpdate).setValue(self.platform.dateTimeToDisplay(self.stateUpdatedTime));
                callback(null);
            });
            callback(null, self.currentState);
        }.bind(self))
        .on('set', function(state, callback) {
            if(state !== self.currentState) {
                self.log.debug("[%s]: set current dimmer state...[%s]", moment().format('YYYYMMDDHHmmss.SSS'), state);
                self.platform['dimmer_' + (state ? 'on':'off')].call(self.platform, self.DeviceID, function(body){
                    self.log.debug(body);
                    self.currentState = state;
                    self.stateUpdatedTime = moment().format('x');

                    self.service.getCharacteristic(Characteristic.On).setValue(self.currentState);
                    self.service.getCharacteristic(LastUpdate).setValue(self.platform.dateTimeToDisplay(self.stateUpdatedTime));
                    callback(null);
                });
            } else {
                callback(null);
            }
        }.bind(self));
}

InsteonDimmerAccessory.prototype.updateDevice = function(devices) {
    var self = this;
    if(InsteonDimmerAccessory.super_.prototype.updateDevice.call(self, devices) && self.lightstateUpdateTime) {
        if(self.stateUpdatedTime !== self.lightstateUpdateTime && self.service) {
            self.stateUpdatedTime = self.lightstateUpdateTime;
            self.service.getCharacteristic(LastUpdate).setValue(self.platform.dateTimeToDisplay(self.stateUpdatedTime));
        }
        if(self.currentState !== self.lightstate && self.service) {
            self.currentState = self.lightstate === 'on' ? true:false;
            self.service.getCharacteristic(Characteristic.On).setValue(self.currentState);
        }
        self.log.debug('[%s]: Light[%s] Light State=[%s], Updated time=[%s]',
            moment().format('YYYYMMDDHHmmss.SSS'),
            self.DeviceName,
            self.lightstate === '1' ? 'on':'off',
            self.platform.dateTimeToDisplay(self.stateUpdatedTime)
        );
    }
}
