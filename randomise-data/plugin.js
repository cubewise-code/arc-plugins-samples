
// Uncomment the code arc.run.. below to enable this plugin

arc.run(['$rootScope', function ($rootScope) {

   $rootScope.plugin("arcRandomiseData", "Randomise Data", "page", {
      menu: "tools",
      icon: "fa-user-secret",
      description: "This plugin can be used to randomize data for any cubes",
      author: "Cubewise",
      url: "https://github.com/cubewise-code/arc-plugins",
      version: "1.0.0"
   });

}]);

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
      controller: ["$scope", "$rootScope", "$http", "$tm1", "$translate", "$timeout", "ngDialog", function ($scope, $rootScope, $http, $tm1, $translate, $timeout, ngDialog) {

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
               $scope.lists.cubes = result.data.value;
            });
         };
         $scope.getCubes();

         $scope.addAllModelCubes = function() {
            $scope.showCubeSelection = false;
            $scope.lists.cubesTarget = [];
            var query = "/Cubes?$select=Name&$filter=indexof(Name,'}') eq -1";
            $http.get(encodeURIComponent($scope.instance) + query).then(function (result) {
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

         $scope.key = function ($event, cube) {
            //Enter
            if ($event.keyCode == 13) {
               if(cube.indexOf("*")==-1){
                  $scope.lists.cubesTarget.push(cube);
               } else{
                  var search = cube.substring(0, cube.length-1);
                  $scope.addMultipleCubes(search);
               }
            }
         }

         $scope.addMultipleCubes = function(string){
            console.log(string);
            var query = "/Cubes?$select=Name&$filter=indexof(Name,'"+string+"') ne -1 &$filter=indexof(Name,'}') eq -1";
            $http.get(encodeURIComponent($scope.instance) + query).then(function (result) {
               var cubes = result.data.value;
               for(var c in cubes){
                  $scope.lists.cubesTarget.push(cubes[c].Name);
               }
            });
         }

         //OPEN MODAL WITH VIEWS TO BE DELETED
         $scope.openModalRandomise = function () {
            var dialog = ngDialog.open({
               className: "ngdialog-theme-default medium",
               template: "__/plugins/randomise-data/m-randomise.html",
               name: "Instances",
               scope: $scope,
               controller: ['$rootScope', '$scope', function ($rootScope, $scope) {
                  $scope.cubesTarget = $scope.ngDialogData.cubesTarget;
                  $scope.cubesRandomized = $scope.ngDialogData.cubesRandomized;
                  $scope.selections.targetFolder = $scope.ngDialogData.targetFolder;

                  //Randomise data
                  $scope.randomiseAll = function () {
                     for (var c in $scope.lists.cubesTarget) {
                        cube = $scope.lists.cubesTarget[c];
                        $scope.randomiseOneCube(cube);
                     }
                  };
                  $scope.randomiseOneCube = function (cube) {
                     var prolog = "DebugUtility( 114, 0, 0, '" + cube + "', '" + $scope.selections.targetFolder + "', '') ;";
                     body = {
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
                           $scope.lists.cubesRandomized.push(cube);
                        } else {
                        }
                     });
                  }
               }],
               data: {
                  cubesTarget: $scope.lists.cubesTarget,
                  cubesRandomized: $scope.lists.cubesRandomized,
                  targetFolder: $scope.selections.targetFolder
               }
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
            if (args.page == "arcRandomiseData" && args.instance == $scope.instance && args.name == null) {
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