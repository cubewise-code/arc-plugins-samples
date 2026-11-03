// Add array to store element names
// Add array.push to include new elements

arc.run(['$rootScope', function ($rootScope) {

   $rootScope.plugin("cubewiseBedrockCubeDataExport", "Bedrock Export", "menu/cube", {
      icon: "fa-cloud-download",
      description: "Exports cube data to a file with the Bedrock.Cube.Data.Export process. Choose the file name and folder, and filter by dimension.",
      author: "Cubewise",
      url: "https://github.com/cubewise-code/arc-plugins-samples/tree/master/bedrock-cube-data-export",
      version: "1.1.0"
      
   });

}]);

arc.run(["$dialogs", function ($dialogs) {

   $dialogs.registerDialog("cubewiseBedrockCubeDataExportDialog", {
      title: "Export data to file",
      directive: "cubewiseBedrockCubeDataExportForm",
      icon: "fa-cloud-download",
      size: "large",
      okButtonLabel: "OK",
      okButtonDisabled: function (data, options) {
         return !data.fileName.length;
      }
   });

}]);

arc.directive("cubewiseBedrockCubeDataExportForm", function () {
   return {
      restrict: "EA",
      replace: true,
      scope: {
         data: "=arcModelData",
         options: "=arcOptions",
         dialog: "=arcDialog"
      },
      templateUrl: "__/plugins/bedrock-cube-data-export/template.html",
      controller: ["$scope", "$subsetDialogs", function ($scope, $subsetDialogs) {

         //Open Subset Editor
         $scope.editSubset = function (dimension) {

            var hierarchy = dimension.hierarchy;

            var handler = function (subset, elements) {
               // subset.selected has what element was clicked
               // dimension.filter will append every selected element
               // if to workaround undefined value being by default
               if (dimension.filter === undefined) {
                  dimension.filter = subset.selected.alias;
               } else {
                  dimension.filter += $scope.data.elementDelim + subset.selected.alias;
               }
            };

            // Probably don't need the expression or expressions (not tested)
            var subset = {
               name: hierarchy.subset,
               expression: hierarchy.expression,
               expressions: hierarchy.expressions,
               alias: hierarchy.alias,
               isSelector: true
            };

            $subsetDialogs.open($scope.data.instance, hierarchy.dimension, hierarchy.name, subset, handler);

         };

      }]
   };
});

arc.service('cubewiseBedrockCubeDataExport', ['$rootScope', '$tm1', '$dialogs', '$http', function ($rootScope, $tm1, $dialogs, $http) {
   // The interface you must implement
   this.execute = function (instance, name) {

      // Create a callback function for the dialog
      var action = function (options) {
         //Overwritte pFilter if filter defined per dimension
         var nbDimensionFiltered = 1;
         _.each(options.dimensions, function (item) {
            if (item.filter) {
               if(nbDimensionFiltered==1){
                  options.filter = item.Name + options.elementStartDelim + item.filter;
               }else{
                  options.filter = options.filter + options.dimensionDelim + item.Name + options.elementStartDelim + item.filter;
               }
               nbDimensionFiltered++;
            }
         });

         var processName = "Bedrock.Cube.Data.Export";

         // Call Bedrock.Cube.Data.Export via the $tm1 service 
         $tm1.processExecute(instance, processName, [
            {
               Name: "pCube",
               Value: name
            }, {
               Name: "pFilter",
               Value: options.filter
            }, {
               Name: "pSkipRules",
               Value: options.skipRules ? 1 : 0
            }, {
               Name: "pSkipCons",
               Value: options.skipCons ? 1 : 0
            }, {
               Name: "pFilePath",
               Value: options.filePath
            }, {
               Name: "pFileName",
               Value: options.fileName
            }, {
               Name: "pDimensionDelim",
               Value: options.dimensionDelim
            }, {
               Name: "pElementStartDelim",
               Value: options.elementStartDelim
            }, {
               Name: "pElementDelim",
               Value: options.elementDelim
            }, {
               Name: "pDebug",
               Value: 0
            }
         ]).then(function (result) {
            if (result.success) {
               // It has finished with success
               $rootScope.reloadInstance(instance);
            }
         });
      };

      
      // Get TM1 instance directory for default file path in dialog window
      var directory;
      var query = "/Configuration?$select=DataBaseDirectory";
      $http.get(encodeURIComponent(instance) + query).then(function (result) {
         directory = result.data.DataBaseDirectory;
      });

      //Get all dimensions
      var query = "/Cubes('" + name + "')/Dimensions?$select=Name";
      $http.get(encodeURIComponent(instance) + query).then(function (result) {
         var dimensions = result.data.value;
         //Create hierarchy property required for Subset Editor
         _.each(dimensions, function(dim){
            dim.hierarchy = {
               name: dim.Name,
               dimension: dim.Name,
               subset:"",
               expression:"",
               expressions:"",
               alias:dim.Name
            }
         });
         // Open the dialog inside the REST API request to make sure the dimensions are initialized

         var data = {
            instance: instance,
            cubeName: name,
            fileName: name + ".csv",
            filePath: directory,
            filter: "",
            dimensionDelim: "&&",
            elementStartDelim: "::",
            elementDelim: "++",
            skipRules: true,
            skipCons: true,
            dimensions: dimensions,
            manualFilter: true,
            exportSeparatorCSV: true
         };

         $dialogs.showDialog("cubewiseBedrockCubeDataExportDialog", data, { title: "Export " + name + " data to file" }, function (result) {
            action(result.data);
         });

      });

   };

}]);