arc.run(['$rootScope', function ($rootScope) {

   $rootScope.plugin("arcCheatSheet", "Cheatsheet", "page", {
      menu: "tools",
      icon: "fa-archive",
      description: "This plugin gathers everything you should now about how to build plugins",
      author: "Cubewise",
      url: "https://github.com/cubewise-code/arc-plugins-samples",
      version: "1.0.0"
   });

}]);

arc.directive("arcCheatSheet", function () {
   return {
      restrict: "EA",
      replace: true,
      scope: {
         instance: "=tm1Instance"
      },
      templateUrl: "__/plugins/cheatsheet/template.html",
      link: function ($scope, element, attrs) {

      },
      controller: ["$scope", "$rootScope", "$http", "$tm1", "$translate", "$timeout", "ngDialog", "$q", "$helper", "$subsetDialogs", function ($scope, $rootScope, $http, $tm1, $translate, $timeout, ngDialog, $q, $helper, $subsetDialogs) {

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
            valueToBeSent: '15',
            dimension: 'Account',
            hierarchy: 'Account',
            subset: 'Default',
            view: 'Default'
         };

         $scope.showHideControlObjects = $rootScope.uiPrefs.controlObjects;

         $scope.encodeURIComponent = encodeURIComponent;

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

         //=======================
         // TM1 Rest Api

         //get number of cubes
         $http.get(encodeURIComponent($scope.instance) + "/Cubes/$count").then(function (value) {
            $scope.nbCubes = value.data;
         });

         //get list of model cubes
         $http.get(encodeURIComponent($scope.instance) + "/ModelCubes()?$select=Name").then(function (value) {
            $scope.modelCubes = value.data.value;
         });

         //get HTTPPortNumber
         $http.get(encodeURIComponent($scope.instance) + "/Configuration/HTTPPortNumber/$value").then(function (value) {
            $scope.httpPortNumber = value.data;
         });

         //get Product Version
         $http.get(encodeURIComponent($scope.instance) + "/Configuration/ProductVersion/$value").then(function (value) {
            $scope.productVersion = value.data;
         });

         //get AdminHost
         $http.get(encodeURIComponent($scope.instance) + "/Configuration/AdminHost/$value").then(function (value) {
            $scope.adminHost = value.data;
            if($scope.adminHost==''){
               $scope.adminHost = 'localhost';
            }
         });

         //========================
         // Arc Services

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

         $scope.sendValueToCell = function (value) {
            $tm1.cellUpdate(value, $scope.instance, $scope.defaults.systemCube, $scope.defaults.element1, $scope.defaults.element2).then(function (data) {
               //console.log(data.status);
               $scope.getValueFromCell();
            });
         };

         // Get Value
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

         $scope.openModalInstances = function (title, message) {
            var dialog = ngDialog.open({
               className: "ngdialog-theme-default large",
               template: "__/plugins/cheatsheet/modal-json-formater.html",
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

         $scope.openModal = function (title, message, size) {
            var dialog = ngDialog.open({
               className: "ngdialog-theme-default " + size,
               template: "__/plugins/cheatsheet/modal.html",
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

         //Function require to open subset editor
         $scope.hierarchy = {
            name: "Account",
            dimension: "Account",
            subset: "Expense",
            expression: "",
            expressions: "",
            alias: "Account"
         }
         $scope.editSubset = function (hierarchy) {
            var handler = function (subset, elements) {
               // subset.selected has what element was clicked
               $scope.elements = subset.selected;
            };
            var subset = {
               name: hierarchy.subset,
               expression: hierarchy.expression,
               expressions: hierarchy.expressions,
               alias: hierarchy.alias,
               isSelector: true
            };
            $subsetDialogs.open($scope.instance, hierarchy.dimension, hierarchy.name, subset, handler);
         };

         //Trigger an event after the login screen
         $scope.$on("login-reload", function (event, args) {

         });

         //Close the tab
         $scope.$on("close-tab", function (event, args) {
            // Event to capture when a user has clicked close on the tab
            if (args.page == "arcCheatSheet" && args.instance == $scope.instance && args.name == null) {
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