
arc.run(['$rootScope', function ($rootScope) {

   $rootScope.plugin("arcServices", "Arc Services", "page", {
      menu: "tools",
      icon: "fa-arrows-h",
      description: "This plugin gives you the list of all available Arc services",
      author: "Cubewise",
      url: "https://github.com/cubewise-code/arc-plugins-samples",
      version: "1.0.0"
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
      controller: ["$scope", "$rootScope", "$http", "$tm1", "$translate", "$timeout", "ngDialog", "$q", "$helper", function ($scope, $rootScope, $http, $tm1, $translate, $timeout, ngDialog, $q, $helper) {

         $scope.defaults = {
            systemCube: 'System info',
            element1: 'Current Date',
            element2: 'Numeric'
         };

         $scope.selections = {
            chore: 'Save Data - Morning',
            process: 'Bedrock.Server.Wait',
            cube: 'General Ledger',
            instance: 'Canvas Sample',
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

         $scope.getValueFromCell = function () {
            var mdxQuery = "SELECT NON EMPTY {[System Info Parameter].[" + $scope.defaults.element1 + "]} ON COLUMNS,NON EMPTY {[System Info Measures].[" + $scope.defaults.element2 + "]} ON ROWS FROM [" + $scope.defaults.systemCube + "]";
            var mdxJSON = { MDX: mdxQuery };
            $http.post(encodeURIComponent($scope.instance) + "/ExecuteMDX?$expand=Cells", mdxJSON).then(function (values) {
               //console.log(values.data.Cells[0].Value);
               // $scope.values.CurrentDate = values.data.Cells[0].Value;
            });
         };

         $scope.getValueFromCell();

         $scope.cellGet = function (instance, cube) {
            var defer = $q.defer();
            //Get all elements
            var tuple = [];
            for (var i = 2; i < arguments.length; i++) {
               tuple.push(arguments[i]);
            }
            $tm1.cubeDimensions(instance, cube).then(function (dims) {
               //Loop through dimensions
               var elements = [];
               for (var i = 0; i < tuple.length; i++) {
                  var item = tuple[i];
                  var dimension = dims[i];
                  var hierarchy = dims[i];
                  var element = $helper.escapeName(item);
                  var parts = item.split("::");
                  if (parts.length == 2) {
                     hierarchy = parts[0];
                     element = parts[1];
                  }
                  //Attach dimension hierarchy and elements together
                  var mdxElement = "[" + dimension + "].[" + hierarchy + "].[" + element + "]";
                  elements.push(mdxElement);
               }
               //Create MDX
               var mdxQuery = "SELECT NON EMPTY {" + elements[0] + "} ON COLUMNS,NON EMPTY {" + elements[1] + "} ON ROWS FROM [" + cube + "]";
               if (elements.length > 2) {
                  mdxQuery = mdxQuery + " WHERE(";
                  for (var i = 2; i < elements.length; i++) {
                     element = elements[i];
                     if (i < elements.length - 1) {
                        mdxQuery = mdxQuery + " " + element + ",";
                     } else {
                        mdxQuery = mdxQuery + " " + element;
                     }
                  }
                  mdxQuery = mdxQuery + " )";
               }
               var mdxJSON = { MDX: mdxQuery };
               $http.post(encodeURIComponent($scope.instance) + "/ExecuteMDX?$expand=Cells", mdxJSON).then(function (values) {
                  defer.resolve(values.data.Cells[0]);
               });
            });
            return defer.promise;
         };

         $scope.cellGet($scope.instance, "General Ledger", "Budget", "2017", "Year", "Local", "Total Europe", "Corporate", "Net Income", "Amount").then(function (data) {
            $scope.returnedValue = data;
         });

         $scope.sendValueToCell = function (value) {
            $tm1.cellUpdate(value, $scope.instance, $scope.defaults.systemCube, $scope.defaults.element1, $scope.defaults.element2).then(function (data) {
               //console.log(data.status);
               $scope.getValueFromCell();
            });
         };

         $scope.openModalInstances = function (title, message) {
            var dialog = ngDialog.open({
               className: "ngdialog-theme-default large",
               template: "__/plugins/services/modal.html",
               name: "Instances",
               controller: ['$rootScope', '$scope', function ($rootScope, $scope) {

                  $scope.title = $scope.ngDialogData.title;
                  $scope.message = $scope.ngDialogData.message;

               }],
               data: {
                  title: title,
                  message: message
               }
            });
         };


         $scope.$on("login-reload", function (event, args) {

         });

         $scope.$on("close-tab", function (event, args) {
            // Event to capture when a user has clicked close on the tab
            if (args.page == "arcServices" && args.instance == $scope.instance && args.name == null) {
               // The page matches this one so close it
               $rootScope.close(args.page, { instance: $scope.instance });
            }
         });

         $scope.$on("$destroy", function (event) {

         });


      }]
   };
});