
arc.run(['$rootScope', function ($rootScope) {

   $rootScope.plugin("arcCubeProcessFeeders", "Process Feeders", "page", {
      menu: "tools",
      icon: "fa-rocket",
      description: "Runs CubeProcessFeeders on the selected cubes and shows how long each one takes",
      author: "Cubewise",
      url: "https://github.com/cubewise-code/arc-plugins-samples/tree/master/process-feeders",
      version: "1.1.0"
   });

}]);

arc.run(["$dialogs", function ($dialogs) {

   $dialogs.registerDialog("arcCubeProcessFeedersDialog", {
      title: "Execute CubeProcessFeeders per cube",
      directive: "arcCubeProcessFeedersForm",
      icon: "fa-rocket",
      size: "small",
      okButtonLabel: "Process feeders",
      okButtonClass: "btn-warning",
      cancelButtonLabel: "CLOSE"
   });

}]);

arc.directive("arcCubeProcessFeedersForm", function () {
   return {
      restrict: "EA",
      replace: true,
      scope: {
         data: "=arcModelData",
         options: "=arcOptions",
         dialog: "=arcDialog"
      },
      templateUrl: "__/plugins/process-feeders/m-processFeeders.html",
      controller: ["$scope", function ($scope) {

         // Colour the badge from the response time
         $scope.generateHSLColour = function (string) {
            var hash = 0;
            string = String(string);
            for (var i = 0; i < string.length; i++) {
               hash = string.charCodeAt(i) + ((hash << 5) - hash);
            }
            var h = hash % 360;
            return {
               "background-color": "hsl(" + h + ", 50%, 50%)",
               "color": "white"
            };
         };

      }]
   };
});

arc.directive("arcCubeProcessFeeders", function () {
   return {
      restrict: "EA",
      replace: true,
      scope: {
         instance: "=tm1Instance"
      },
      templateUrl: "__/plugins/process-feeders/template.html",
      link: function ($scope, element, attrs) {

      },
      controller: ["$scope", "$rootScope", "$http", "$tm1", "$translate", "$timeout", "$dialogs", function ($scope, $rootScope, $http, $tm1, $translate, $timeout, $dialogs) {

         //Define variables
         $scope.defaults = {
            optionsShow: 'SaveDataAll',
            selectAllCubes: false,
            title: 'SaveDataAll or CubeSaveData',
            showBadgeTime: true,
            showAllCubes: false
         };
         $scope.selections = {
            optionsShow: $scope.defaults.optionsShow,
            cubeFilter: '',
            cubeSelectedFilter: '',
            showAlert: true,
            title: $scope.defaults.title,
            responseTimeMs: 0,
            showAllCubes: $scope.defaults.showAllCubes
         };
         $scope.lists = {
            cubes: [],
            cubesTarget: [],
            cubesRandomized: [],
            optionsSaveData: [
               { name: 'SaveDataAll', icon: 'cubes', align: 'pull-right' },
               { name: 'CubeSaveData', icon: 'cube', align: 'pull-left' }]
         };
         $scope.values = {};

         $scope.showCubeSelection = true;

         $scope.removeFromCubesTarget = function (cube) {
            $scope.lists.cubesTarget.splice($scope.lists.cubesTarget.indexOf(cube), 1);
         }

         //Functions
         $scope.getCubes = function () {
            var query = "";
            var queryAll = "/Cubes?$select=Name,Rules";
            var queryWithoutControlObjects = "/Cubes?$select=Name,LastDataUpdate,LastSchemaUpdate&$filter=indexof(Name,'}') eq -1";
            if ($rootScope.uiPrefs.controlObjects) {
               query = queryAll;
            } else {
               query = queryWithoutControlObjects;
            }
            $scope.lists.cubesWithRules = [];
            $http.get(encodeURIComponent($scope.instance) + query).then(function (result) {
               $scope.lists.cubes = result.data.value;
               _.each($scope.lists.cubes, function (cube) {
                  if (cube.Rules){
                     $scope.lists.cubesWithRules.push(cube);
                  }
                  var queryDimensions = "/Cubes('" + cube.Name + "')/Dimensions";
                  $http.get(encodeURIComponent($scope.instance) + queryDimensions).then(function (dimensions) {
                     cube.dimensions = dimensions.data.value;
                  });
               });
            });
         };
         $scope.getCubes();

         $scope.checkCubeDataUpdate = function (dateISO) {
            return moment().diff(dateISO, 'hours');
         };

         // TOGGLE DELETE VIEWS
         $scope.cubesToSave = [];
         $scope.toggleCubeToSave = function (item) {
            if (_.includes($scope.cubesToSave, item)) {
               _.remove($scope.cubesToSave, function (i) {
                  return i.Name === item.Name;
               });
            } else {
               $scope.cubesToSave.push(item);
            }
         };
         $scope.toggleAllCubeToSave = function () {
            _.each($scope.lists.cubes, function (item) {
               if (item.Name.toLowerCase().includes($scope.selections.cubeFilter.toLowerCase())) {
                  item.processFeeders = $scope.defaults.selectAllCubes;
                  $scope.toggleCubeToSave(item);
               }
            });
         };

         // OPEN DIALOG WITH THE CUBES TO PROCESS
         $scope.openModalprocessFeeders = function () {
            var data = {
               cubes: _.map($scope.cubesToSave, function (cube) { return { Name: cube.Name }; }),
               responseTimeMs: 0
            };
            $dialogs.showDialog("arcCubeProcessFeedersDialog", data, null, function (result) {
               $scope.processFeedersPerCubes(result.data);
               // Returning true keeps the dialog open so the response times can be read
               return true;
            });
         };

         $scope.processFeedersPerCubes = function (data) {
            data.responseTimeMs = 0;
            _.forEach(data.cubes, function (cube) {
               $scope.processFeedersForOneCube(cube, data);
            });
         };

         $scope.processFeedersForOneCube = function (cube, data) {
            cube.sendDate = (new Date()).getTime();
            var prolog = "CubeProcessFeeders('" + cube.Name + "');";
            var body = {
               Process: {
                  PrologProcedure: prolog
               }
            };
            var config = {
               method: "POST",
               url: encodeURIComponent($scope.instance) + "/ExecuteProcess",
               data: body
            };
            $http(config).then(function (result) {
               if (result.status < 400) {
                  cube.receiveDate = (new Date()).getTime();
                  cube.responseTimeMs = cube.receiveDate - cube.sendDate;
                  data.responseTimeMs = data.responseTimeMs + cube.responseTimeMs;
               } else {
                  cube.failed = true;
               }
            });
         };

         $scope.showBadgeTimeCube = function (cube) {
            cube.showBadgeTime = false;
         }

         $scope.addToFilter = function (param) {
            $scope.selections.cubeFilter = param;
         };

         $scope.clearFilter = function () {
            $scope.selections.cubeFilter = "";
         };

         //Manage color:
         $scope.generateHSLColour = function (string) {
            //HSL refers to hue, saturation, lightness
            var styleObject = {
               "background-color": "",
               "color": "white"
            };
            //for ngStyle format
            var hash = 0;
            var saturation = "50";
            var lightness = "50";
            for (var i = 0; i < string.length; i++) {
               hash = string.charCodeAt(i) + ((hash << 5) - hash);
            }
            var h = hash % 360;
            styleObject["background-color"] = 'hsl(' + h + ', ' + saturation + '%, ' + lightness + '%)';
            return styleObject;
         };

         //Trigger an event after the login screen
         $scope.$on("login-reload", function (event, args) {

         });

         //Close the tab
         $scope.$on("close-tab", function (event, args) {
            // Event to capture when a user has clicked close on the tab
            if (args.page == "arcCubeProcessFeeders" && args.instance == $scope.instance && args.name == null) {
               // The page matches this one so close it
               $rootScope.close(args.page, { instance: $scope.instance });
            }
         });

         //Trigger an event after the plugin closes
         $scope.$on("$destroy", function (event) {

         });


      }]
   };
});