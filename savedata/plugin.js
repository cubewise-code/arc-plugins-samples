
// Uncomment the code arc.run.. below to enable this plugin

arc.run(['$rootScope', function ($rootScope) {

   $rootScope.plugin("arcSaveData", "Save Data", "page", {
      menu: "tools",
      icon: "fa-cubes",
      description: "This plugin can be used to randomize data for any cubes",
      author: "Cubewise",
      url: "https://github.com/cubewise-code/arc-plugins",
      version: "1.0.0"
   });

}]);

arc.directive("arcSaveData", function () {
   return {
      restrict: "EA",
      replace: true,
      scope: {
         instance: "=tm1Instance"
      },
      templateUrl: "__/plugins/savedata/template.html",
      link: function ($scope, element, attrs) {

      },
      controller: ["$scope", "$rootScope", "$http", "$tm1", "$translate", "$timeout", "ngDialog", function ($scope, $rootScope, $http, $tm1, $translate, $timeout, ngDialog) {

         //Define variables
         $scope.defaults = {
            optionsShow : 'SaveDataAll',
            selectAllCubes : false,
            title:'SaveDataAll or CubeSaveData',
            showBadgeTime : true
         };
         $scope.selections = {
            optionsShow : $scope.defaults.optionsShow,
            cubeFilter:'',
            cubeSelectedFilter:'',
            showAlert:true,
            title: $scope.defaults.title,
            responseTimeMs: 0
         };
         $scope.lists = {
            cubes: [],
            cubesTarget: [],
            cubesRandomized: [],
            optionsSaveData:[
               {name:'SaveDataAll',icon:'cubes', align:'pull-right'},
               {name:'CubeSaveData',icon:'cube', align:'pull-left'}]
         };
         $scope.values = {};

         $scope.showCubeSelection = true;

         $scope.removeFromCubesTarget = function(cube){
            $scope.lists.cubesTarget.splice($scope.lists.cubesTarget.indexOf(cube), 1);
         }

         //Functions
         $scope.getCubes = function () {
            var query = "";
            var queryAll = "/Cubes?$select=Name,LastDataUpdate,LastSchemaUpdate";
            var queryWithoutControlObjects = "/Cubes?$select=Name,LastDataUpdate,LastSchemaUpdate&$filter=indexof(Name,'}') eq -1";
            if ($rootScope.uiPrefs.controlObjects) {
               query = queryAll;
            } else {
               query = queryWithoutControlObjects;
            }
            $http.get(encodeURIComponent($scope.instance) + query).then(function (result) {
               $scope.lists.cubes = result.data.value;
               $scope.checkCubesDataUpdate();
            });
         };
         $scope.getCubes();

         $scope.checkCubesDataUpdate = function(){
            for(var c in $scope.lists.cubes){
               $scope.lists.cubes[c].dataUpdateHoursDelta = $scope.checkCubeDataUpdate($scope.lists.cubes[c].LastDataUpdate);
            }
         };

         $scope.checkCubeDataUpdate = function(dateISO){
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
            _.each($scope.lists.cubes, function(item){
               if(item.Name.toLowerCase().includes($scope.selections.cubeFilter.toLowerCase())){
                     item.saveData = $scope.defaults.selectAllCubes;
                     $scope.toggleCubeToSave(item);
               }
            });            
         };

         //OPEN MODAL WITH SAVEDATALL
         $scope.openModalSaveDataAll = function () {
            $scope.selections.responseTimeMs = 0;
            var dialog = ngDialog.open({
               className: "ngdialog-theme-default small",
               template: "__/plugins/savedata/m-saveDataAll.html",
               name: "Instances",
               scope: $scope,
               controller: ['$rootScope', '$scope', function ($rootScope, $scope) {
                  $scope.cubesToSave = $scope.ngDialogData.cubesToSave;

                  $scope.saveDataAll = function () {
                     console.log("SaveData executed")
                     var sendDate = (new Date()).getTime();
                     var prolog = "SaveDataAll;";
                     body = {
                        Process: {
                           Name: "SaveData",
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
                           $scope.saveDataStatus=true;
                        } else {
                        }
                        var receiveDate = (new Date()).getTime();
                        $scope.selections.responseTimeMs = receiveDate - sendDate;
                     });
                  }
               }],
               data: {
                  cubesToSave: $scope.cubesToSave
               }
            });
         };

         //OPEN MODAL WITH SAVEDATALL
         $scope.openModalSaveData = function () {
            $scope.selections.responseTimeMs = 0;
            var dialog = ngDialog.open({
               className: "ngdialog-theme-default small",
               template: "__/plugins/savedata/m-saveData.html",
               name: "Instances",
               scope: $scope,
               controller: ['$rootScope', '$scope', function ($rootScope, $scope) {
                  $scope.cubesToSave = $scope.ngDialogData.cubesToSave;
               }],
               data: {
                  cubesToSave: $scope.cubesToSave
               }
            });
         };

         $scope.saveDataPerCubes = function () {
            $scope.selections.responseTimeMs = 0;
            for(var c in $scope.cubesToSave){
               $scope.saveDataForOneCube($scope.cubesToSave[c]);
            }
         }

         $scope.saveDataForOneCube = function(cube){
            cube.showBadgeTime=true;
            cube.sendDate = (new Date()).getTime();
            var prolog = "CubeSaveData('"+cube.Name+"');";
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
               if (result.status < 400) {
                  $scope.saveDataStatus=true;
                  cube.receiveDate = (new Date()).getTime();
                  cube.responseTimeMs = cube.receiveDate - cube.sendDate;
                  $scope.selections.responseTimeMs = $scope.selections.responseTimeMs + cube.responseTimeMs;
                  $timeout(function() { $scope.showBadgeTimeCube(cube); }, 20000);
               } else {
                  //error
               }
            });
         }

         $scope.showBadgeTimeCube = function(cube){
            cube.showBadgeTime = false;
         }

         //Trigger an event after the login screen
         $scope.$on("login-reload", function (event, args) {

         });

         //Close the tab
         $scope.$on("close-tab", function (event, args) {
            // Event to capture when a user has clicked close on the tab
            if (args.page == "arcSaveData" && args.instance == $scope.instance && args.name == null) {
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