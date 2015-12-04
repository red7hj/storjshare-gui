/**
 * @module driveshare-gui/views
 */

'use strict';

var $ = window.jQuery = require('jquery');
var Vue = require('vue');

require('bootstrap'); // init bootstrap js

var ipc = require('electron-safe-ipc/guest');
var shell = require('shell');
var about = require('../package');
var Updater = require('./updater').Updater;
var UserData = require('./userdata'), userdata = new UserData();
var Tab = require('./tab');
var dataserv = require('./dataserv');
var Installer = require('./installer'), installer = new Installer();
var fs = require('fs');
var diskspace = require('diskspace');

/**
 * Logger View
 */
var logs = new Vue({
  el: '#logs',
  data: {
    output: ''
  },
  methods: {
    show: function(event) {
      if (event) {
        event.preventDefault();
      }

      $('#logs').modal('show');
      this.scrollToBottom();
    },
    scrollToBottom: function() {
      var logoutput = document.getElementById('logoutput');
      logoutput.scrollTop = logoutput.scrollHeight * 2;
    }
  },
  created: function() {
    ipc.on('showLogs', this.show.bind(this));
  }
});

/**
 * Setup View
 */
var setup = new Vue({
  el: '#setup',
  data: {
    title: 'Welcome to DriveShare',
    working: true,
    status: '',
    linux: installer._platform === 'linux',
    password: ''
  },
  methods: {
    setup: function() {
      var self = this;

      installer.removeAllListeners();

      installer.on('status', function(status) {
        self.status = status;
      });

      installer.on('error', function(err) {
        self.working = false;
        self.error = err.message;
      });

      installer.on('end', function() {
        self.working = false;
        $('#setup').modal('hide');
      });

      installer.install(self.password);
    },
    reload: function() {
      location.reload();
    }
  },
  created: function() {
    var self = this;

    installer.check(function(err, installed) {
      if (err || !installed) {
        if (err) {
          self.status = err.message;
        }

        if (!self.linux) {
          self.setup();
        }

        $('#setup').modal('show');
      }
    });
  }
});

/**
 * About View
 */
var about = new Vue({
  el: '#about',
  data: {
    version: about.version
  },
  methods: {
    show: function(event) {
      if (event) {
        event.preventDefault();
      }

      $('#about').modal('show');
    }
  },
  created: function() {
    var view = this;

    ipc.on('showAboutDialog', function() {
      view.show();
    });
  }
});

/**
 * Updater View
 */
var updater = new Vue({
  el: '#updater',
  data: {
    update: false
  },
  methods: {
    download: function(event) {
      if (event) {
        event.preventDefault();
      }

      shell.openExternal('https://github.com/Storj/driveshare-gui/releases');
    }
  },
  created: function() {
    var view = this;
    var updater = new Updater();

    updater.on('update_available', function() {
      view.update = true;

      $('#updater').modal('show');
    });

    ipc.on('checkForUpdates', function() {
      $('#updater').modal('show');
    });
  }
});

/**
 * Main View
 */
var main = new Vue({
  el: '#main',
  data: {
    userdata: userdata._parsed,
    current: 0,
    running: [],
    transitioning: false,
    freespace: ''
  },
  methods: {
    addTab: function(event) {
      if (event) {
        event.preventDefault();
      }

      this.showTab(this.userdata.tabs.push(new Tab()) - 1);
    },
    showTab: function(index) {
      if (this.userdata.tabs[this.current]) {
        this.userdata.tabs[this.current].active = false;
      }

      if (index === -1) {
        this.current = 0;

        if (!this.userdata.tabs[this.current]) {
          this.addTab();
          this.userdata.tabs[this.current].active = true;
        }
      } else {
        this.userdata.tabs[index].active = true;
        this.current = index;
      }

      this.getFreeSpace();
      this.renderLogs(this.running[this.current]);
      ipc.send('tabChanged', !!this.running[this.current]);
    },
    renderLogs: function(running) {
      this.running.forEach(function(proc) {
        proc._logger.removeAllListeners();
      });

      if (running) {
        running._logger.on('log', function() {
          if (!!running) {
            logs.output = running._logger._output;

            setImmediate(function() {
              logs.scrollToBottom();
            });
          }
        });
      }

      logs.output = !!running ? running._logger._output : '';
    },
    removeTab: function() {
      if (!window.confirm('Are you sure you want to remove this drive?')) {
        return;
      }

      var id = this.userdata.tabs[this.current].id;

      this.stopFarming();
      this.userdata.tabs.splice(this.current, 1);
      this.showTab(this.current - 1);

      this.saveTabToConfig(function(err) {
        if (err) {
          return window.alert(err.message);
        }

        if (fs.existsSync(dataserv._getConfigPath(id))) {
          fs.unlinkSync(dataserv._getConfigPath(id));
        }
      });
    },
    validateCurrentTab: function() {
      userdata.validate(this.current);
    },
    saveTabToConfig: function(callback) {
      userdata.saveConfig(callback);
    },
    selectStorageDirectory: function() {
      ipc.send('selectStorageDirectory');
    },
    startFarming: function(event) {
      var self = this;
      var tab = this.userdata.tabs[this.current];
      var dscli = installer.getDataServClientPath();

      if (event) {
        event.preventDefault();
      }

      this.transitioning = true;

      try {
        userdata.validate(this.current);
      } catch(err) {
        return window.alert(err.message);
      }

      this.saveTabToConfig(function(err) {
        if (err) {
          self.transitioning = false;
          return window.alert(err.message);
        }

        dataserv.validateClient(dscli, function(err) {
          if (err) {
            self.transitioning = false;
            return window.alert(err.message);
          }

          dataserv.setAddress(tab.address, tab.id, function(err) {
            if (err) {
              self.transitioning = false;
              return window.alert('Failed to set address ' + tab.address);
            }

            Vue.set(self.running, self.current, dataserv.farm(tab));

            self.transitioning = false;

            self.running[self.current].on('error', function() {
              self.running[self.current] = false;
              ipc.send('processTerminated');
            });

            self.running[self.current].on('exit', function() {
              self.running[self.current] = false;
              ipc.send('processTerminated');
            });

            self.showTab(self.current);
          });
        });
      });
    },
    stopFarming: function(event) {
      if (event) {
        event.preventDefault();
      }

      if (this.running[this.current]) {
        this.running[this.current].kill();
        this.running[this.current] = false;
      }
    },
    getFreeSpace: function() {
      var self = this;
      var tab = this.userdata.tabs[this.current];
      var drive = tab.storage.path.substr(0, 1);
      var freespace = 0;

      this.freespace = '...';

      diskspace.check(drive, function(err, total, free) {
        if (err) {
          self.freespace = 'Free Space: ?';
          return;
        }

        switch (tab.storage.unit) {
          case 'MB':
            freespace = (free * 1e-6).toFixed(0);
            break;
          case 'GB':
            freespace = (free * 1e-9).toFixed(1);
            break;
          case 'TB':
            freespace = (free * 1e-12).toFixed(2);
            break;
        }

        self.freespace = 'Free Space: ' + freespace + ' ' + tab.storage.unit;
      });
    }
  },
  created: function() {
    var self = this;

    $('.container').addClass('visible');

    if (!this.userdata.tabs.length) {
      this.addTab();
    } else {
      this.userdata.tabs.forEach(function(tab, index) {
        if (tab.active) {
          self.current = index;
        }
      });
    }

    this.showTab(this.current);

    ipc.on('storageDirectorySelected', function(path) {
      self.userdata.tabs[self.current].storage.path = path[0];
    });

    ipc.on('farm', this.startFarming.bind(this));
    ipc.on('terminateProcess', this.stopFarming.bind(this));
  }
});

/**
 * Footer View
 */
var footer = new Vue({
  el: '#footer',
  data: {},
  methods: {
    showLogs: function(event) {
      if (event) {
        event.preventDefault();
      }

      logs.show();
    }
  }
});

/**
 * Expose view objects
 * #exports
 */
module.exports = {
  setup: setup,
  logs: logs,
  updater: updater,
  about: about,
  main: main,
  footer: footer
};
