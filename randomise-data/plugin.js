
arc.run(['$rootScope', function ($rootScope) {

   $rootScope.plugin("arcRandomiseData", "Randomise Data", "page", {
      menu: "tools",
      icon: "fa-user-secret",
      description: "This plugin can be used to randomize data for any cubes",
      author: "Cubewise",
      url: "https://github.com/cubewise-code/arc-plugins-samples/tree/master/randomise-data",
      version: "2.0.0"
   });

}]);

arc.run(["$dialogs", function ($dialogs) {

   $dialogs.registerDialog("arcRandomiseDataDialog", {
      title: "Randomise data for following cubes",
      directive: "arcRandomiseDataForm",
      icon: "fa-user-secret",
      size: "medium",
      okButtonLabel: "Randomise",
      okButtonClass: "btn-danger",
      cancelButtonLabel: "CLOSE",
      // Once the cubes are randomised the results are shown, so Randomise is disabled
      okButtonDisabled: function (data, options) {
         return data.cubesRandomized.length > 0;
      }
   });

}]);

arc.directive("arcRandomiseDataForm", function () {
   return {
      restrict: "EA",
      replace: true,
      scope: {
         data: "=arcModelData",
         options: "=arcOptions",
         dialog: "=arcDialog"
      },
      templateUrl: "__/plugins/randomise-data/m-randomise.html"
   };
});

arc.directive("arcRandomiseData", function () {
   return {
      restrict: "EA",
      replace: true,
      scope: {
         instance: "=tm1Instance"
      },
      templateUrl: "__/plugins/randomise-data/template.html",
      link: function ($scope, element, attrs) {

      },
      controller: ["$scope", "$rootScope", "$http", "$tm1", "$translate", "$timeout", "$dialogs", function ($scope, $rootScope, $http, $tm1, $translate, $timeout, $dialogs) {

         var _logger = log.getLogger("RandomiseData");

         //Define variables
         $scope.defaults = {};
         $scope.selections = {
            targetFolder: "C:/Arc/plugins/randomise-data"
         };
         $scope.lists = {
            cubes: [],
            cubesTarget: [],
            cubesRandomized: []
         };
         $scope.values = {};
         $scope.selection = { cube: "" };

         $scope.showCubeSelection = true;

         $scope.removeFromCubesTarget = function(cube){
            $scope.lists.cubesTarget.splice($scope.lists.cubesTarget.indexOf(cube), 1);
         }

         //Functions
         $scope.getCubes = function () {
            var query = "";
            var queryAll = "/Cubes?$select=Name";
            var queryWithoutControlObjects = "/Cubes?$select=Name&$filter=indexof(Name,'}') eq -1";
            if ($rootScope.uiPrefs.controlObjects) {
               query = queryAll;
            } else {
               query = queryWithoutControlObjects;
            }
            $http.get(encodeURIComponent($scope.instance) + query).then(function (result) {
               if (result.status == 200) {
                  $scope.lists.cubes = result.data.value;
               }
            });
         };
         $scope.getCubes();

         $scope.addAllModelCubes = function() {
            $scope.showCubeSelection = false;
            $scope.lists.cubesTarget = [];
            var query = "/Cubes?$select=Name&$filter=indexof(Name,'}') eq -1";
            $http.get(encodeURIComponent($scope.instance) + query).then(function (result) {
               if (result.status != 200) {
                  return;
               }
               var cubes = result.data.value;
               for(var c in cubes){
                  $scope.lists.cubesTarget.push(cubes[c].Name);
               }
            });
         }

         $scope.selectPerCubes = function() {
            $scope.showCubeSelection = true;
            $scope.lists.cubesTarget = [];
         }

         // Add one cube to the list, once
         $scope.addCube = function (cube) {
            if (cube && $scope.lists.cubesTarget.indexOf(cube) == -1) {
               $scope.lists.cubesTarget.push(cube);
            }
            $scope.selection.cube = "";
         }

         $scope.key = function ($event, cube) {
            //Enter
            if ($event.keyCode == 13 && cube) {
               if(cube.indexOf("*")==-1){
                  $scope.addCube(cube);
               } else{
                  var search = cube.substring(0, cube.length-1);
                  $scope.addMultipleCubes(search);
                  $scope.selection.cube = "";
               }
            }
         }

         $scope.addMultipleCubes = function(string){
            _logger.debug("Adding cubes that contain " + string);
            var query = "/Cubes?$select=Name&$filter=indexof(Name,'"+string+"') ne -1 &$filter=indexof(Name,'}') eq -1";
            $http.get(encodeURIComponent($scope.instance) + query).then(function (result) {
               if (result.status != 200) {
                  return;
               }
               var cubes = result.data.value;
               for(var c in cubes){
                  $scope.lists.cubesTarget.push(cubes[c].Name);
               }
            });
         }

         // OPEN DIALOG WITH THE CUBES TO RANDOMISE
         $scope.openModalRandomise = function () {
            var data = {
               cubesTarget: _.clone($scope.lists.cubesTarget),
               cubesRandomized: [],
               targetFolder: $scope.selections.targetFolder
            };
            $dialogs.showDialog("arcRandomiseDataDialog", data, null, function (result) {
               $scope.randomiseAll(result.data);
               // Returning true keeps the dialog open so the result can be read
               return true;
            });
         };

         // RANDOMISE DATA
         $scope.randomiseAll = function (data) {
            _.forEach(data.cubesTarget, function (cube) {
               $scope.randomiseOneCube(cube, data);
            });
         };

         $scope.randomiseOneCube = function (cube, data) {

            var folderPath = data.targetFolder.replace(/\//g, "\\");

            var createFolderProcess = {
               Process: {
                  PrologProcedure: "ExecuteCommand('cmd /c if not exist \"" + folderPath + "\" mkdir \"" + folderPath + "\"', 1);"
               }
            };

            var createFolderUrl = encodeURIComponent($scope.instance) + "/ExecuteProcess";
            $http.post(createFolderUrl, createFolderProcess).then(function () {

               var prolog = "DebugUtility( 114, 0, 0, '" + cube + "', '" + data.targetFolder + "', '') ;";

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
                  if (result.status == 200 || result.status == 201 || result.status == 204) {
                     data.cubesRandomized.push(cube);
                  }
               });
            });
         };

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
            if (args.page == "arcRandomiseData" && args.instance == $scope.instance) {
               // The page matches this one so close it
               $rootScope.close(args.page, args);
            }
         });

         //Trigger an event after the plugin closes
         $scope.$on("$destroy", function (event) {

         });


      }]
   };
});