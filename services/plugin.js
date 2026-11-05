
arc.run(['$rootScope', function ($rootScope) {

   $rootScope.plugin("arcServices", "Arc Services (Sample)", "page", {
      menu: "tools",
      icon: "fa-arrows-h",
      description: "This plugin gives you the list of all available Arc services",
      author: "Cubewise",
      url: "https://github.com/cubewise-code/arc-plugins-samples/tree/master/services",
      version: "2.0.0"
   });

}]);

arc.directive("arcServices", function () {
   return {
      restrict: "EA",
      replace: true,
      scope: {
         instance: "=tm1Instance"
      },
      templateUrl: "__/plugins/services/template.html",
      link: function ($scope, element, attrs) {

      },
      controller: ["$scope", "$rootScope", "$http", "$tm1", "$translate", "$timeout", "$dialogs", "$q", "$helper", function ($scope, $rootScope, $http, $tm1, $translate, $timeout, $dialogs, $q, $helper) {

         $scope.defaults = {
            systemCube: 'System info',
            element1: 'Current Date',
            element2: 'Numeric'
         };

         $scope.selections = {
            chore: '',
            process: '',
            cube: '',
            instance: $scope.instance,
            valueToBeSent: '15'
         };

         $scope.results = {};

         $scope.values = {
            currentDate: '0'
         }

         $scope.options = {
            showInstanceInfo: false
         }

         $scope.lists = {
            instances: [],
            instanceData: []
         }

         $scope.executeChore = function (name) {
            $tm1.choreExecute($scope.instance, name);
         };

         $scope.executeProcess = function (name) {
            $tm1.processExecute($scope.instance, name);
         };

         $scope.getInstances = function () {
            $tm1.instances().then(function (data) {
               $scope.lists.instances = data;
               //Open Modal
               $scope.openModalInstances("List of instances", $scope.lists.instances);
            });
         };

         $scope.getInstance = function (name) {
            $scope.options.showInstanceInfo = !$scope.options.showInstanceInfo;
            $tm1.instance(name).then(function (data) {
               $scope.lists.instanceData = data;
               $scope.openModalInstances($scope.selections.instance, $scope.lists.instanceData);
            });
         };

         $scope.getCubeDimensions = function (cube) {
            $tm1.cubeDimensions($scope.instance, cube).then(function (data) {
               $scope.lists.dimensions = data;
               $scope.openModalInstances($scope.selections.cube, $scope.lists.dimensions);
            });
         };

         // Fill the examples with objects this instance has, so the samples work on any model
         $http.get(encodeURIComponent($scope.instance) + "/Cubes?$select=Name&$top=1&$filter=indexof(Name,'}') eq -1").then(function (result) {
            if (result.status == 200 && result.data.value.length > 0) {
               $scope.selections.cube = result.data.value[0].Name;
            }
         });

         $scope.sendValueToCell = function (value) {
            // This example writes to a cube of the Canvas Sample model, so check the cube is there first
            $http.get(encodeURIComponent($scope.instance) + "/Cubes('" + $scope.defaults.systemCube + "')?$select=Name").then(function (result) {
               if (result.status != 200) {
                  $dialogs.error("Cube not found", "This example writes to the cube '" + $scope.defaults.systemCube + "', which is only in the Canvas Sample model. Change $scope.defaults in plugin.js to a cube and elements of your own model to try it.");
                  return;
               }
               // The 4th argument is the sandbox, null writes to the base data
               $tm1.cellUpdate(value, $scope.instance, $scope.defaults.systemCube, null, $scope.defaults.element1, $scope.defaults.element2);
            });
         };

         $scope.openModalInstances = function (title, message) {
            // jsonViewerDialog is built into Arc
            $dialogs.showDialog("jsonViewerDialog", { json: message }, { title: title });
         };


         $scope.$on("login-reload", function (event, args) {

         });

         $scope.$on("close-tab", function (event, args) {
            // Event to capture when a user has clicked close on the tab
            if (args.page == "arcServices" && args.instance == $scope.instance) {
               // The page matches this one so close it
               $rootScope.close(args.page, args);
            }
         });

         $scope.$on("$destroy", function (event) {

         });


      }]
   };
});