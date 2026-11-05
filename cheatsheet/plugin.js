arc.run(['$rootScope', function ($rootScope) {

   $rootScope.plugin("arcCheatSheet", "Cheatsheet (Sample)", "page", {
      menu: "tools",
      icon: "fa-archive",
      description: "This plugin gathers everything you should now about how to build plugins",
      author: "Cubewise",
      url: "https://github.com/cubewise-code/arc-plugins-samples/tree/master/cheatsheet",
      version: "2.0.0"
   });

}]);

arc.run(["$dialogs", function ($dialogs) {

   // One registration per size so the cheatsheet can show them side by side
   _.forEach(["small", "medium", "large"], function (size) {
      $dialogs.registerDialog("arcCheatSheet" + _.upperFirst(size) + "Dialog", {
         title: "Cheatsheet",
         directive: "arcCheatSheetMessage",
         icon: "fa-archive",
         size: size,
         okButtonClass: "d-none",
         cancelButtonLabel: "CLOSE"
      });
   });

}]);

arc.directive("arcCheatSheetMessage", function () {
   return {
      restrict: "E",
      replace: true,
      scope: {
         data: "=arcModelData",
         options: "=arcOptions",
         dialog: "=arcDialog"
      },
      template: "<div>{{data.message}}</div>"
   };
});

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
      controller: ["$scope", "$rootScope", "$http", "$tm1", "$translate", "$timeout", "$dialogs", "$q", "$helper", "$subsetDialogs", function ($scope, $rootScope, $http, $tm1, $translate, $timeout, $dialogs, $q, $helper, $subsetDialogs) {

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
            valueToBeSent: '15',
            dimension: '',
            hierarchy: '',
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

         // A failed request resolves into .then, so check the status before using the data

         //get number of cubes
         $http.get(encodeURIComponent($scope.instance) + "/Cubes/$count").then(function (value) {
            if (value.status == 200) {
               $scope.nbCubes = value.data;
            }
         });

         //get list of model cubes
         $http.get(encodeURIComponent($scope.instance) + "/ModelCubes()?$select=Name").then(function (value) {
            if (value.status == 200) {
               $scope.modelCubes = value.data.value;
            }
         });

         //get HTTPPortNumber
         $http.get(encodeURIComponent($scope.instance) + "/Configuration/HTTPPortNumber/$value").then(function (value) {
            if (value.status == 200) {
               $scope.httpPortNumber = value.data;
            }
         });

         //get Product Version
         $http.get(encodeURIComponent($scope.instance) + "/Configuration/ProductVersion/$value").then(function (value) {
            if (value.status == 200) {
               $scope.productVersion = value.data;
            }
         });

         //get AdminHost
         $http.get(encodeURIComponent($scope.instance) + "/Configuration/AdminHost/$value").then(function (value) {
            if (value.status == 200) {
               $scope.adminHost = value.data;
               if ($scope.adminHost == '') {
                  $scope.adminHost = 'localhost';
               }
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

         // Fill the examples with objects this instance has, so the samples work on any model
         $http.get(encodeURIComponent($scope.instance) + "/Cubes?$select=Name&$top=1&$filter=indexof(Name,'}') eq -1").then(function (result) {
            if (result.status == 200 && result.data.value.length > 0) {
               $scope.selections.cube = result.data.value[0].Name;
               // The first dimension of that cube feeds the subset and link examples
               $http.get(encodeURIComponent($scope.instance) + "/Cubes('" + $scope.selections.cube.replace(/'/g, "''") + "')/Dimensions?$select=Name&$top=1").then(function (dims) {
                  if (dims.status == 200 && dims.data.value.length > 0) {
                     $scope.selections.dimension = dims.data.value[0].Name;
                     $scope.selections.hierarchy = dims.data.value[0].Name;
                     $scope.hierarchy.name = dims.data.value[0].Name;
                     $scope.hierarchy.dimension = dims.data.value[0].Name;
                     $scope.hierarchy.alias = dims.data.value[0].Name;
                  }
               });
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


         $scope.openModalInstances = function (title, message) {
            // jsonViewerDialog is built into Arc
            $dialogs.showDialog("jsonViewerDialog", { json: message }, { title: title });
         };

         $scope.openModal = function (title, message, size) {
            $dialogs.showDialog("arcCheatSheet" + _.upperFirst(size) + "Dialog", { message: message }, { title: title });
         };

         //Function require to open subset editor
         $scope.hierarchy = {
            name: "",
            dimension: "",
            subset: "Default",
            expression: "",
            expressions: "",
            alias: ""
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
            if (args.page == "arcCheatSheet" && args.instance == $scope.instance) {
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