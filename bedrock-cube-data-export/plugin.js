// Add array to store element names
// Add array.push to include new elements

arc.run(['$rootScope', function ($rootScope) {

   $rootScope.plugin("cubewiseBedrockCubeDataExport", "Bedrock Export", "menu/cube", {
      icon: "fa-cloud-download",
      description: "This plugin exports cube data using Bedrock.Cube.Data.Export process. You can specify:....",
      author: "Cubewise",
      url: "https://github.com/cubewise-code/arc-plugins",
      version: "1.0.2"
      
   });

}]);

arc.service('cubewiseBedrockCubeDataExport', ['$rootScope', '$tm1', 'ngDialog', '$dialogs', '$http', function ($rootScope, $tm1, ngDialog, $dialogs, $http) {
   // The interface you must implement
   this.execute = function (instance, name) {

      // Create a callback function for the dialog
      var action = function (options) {
         dialog.close();
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

      var dialog = undefined;
      
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
         // console.log(dimensions);
         // Use ngDialog (https://github.com/likeastore/ngDialog) for custom dialog boxes
         // Pass a template URL to use an external file, path should start with __/plugins/{{your-plugin-name}}
         // Use the data option to pass through data (or functions to the template), the data is then used in
         //  the template with ngDialogData
         // vincent:
         //initialize the dialog box inside the REST API request to make sure the dimensions are initialized

         dialog = ngDialog.open({
            className: "ngdialog-theme-default",
            template: "__/plugins/bedrock-cube-data-export/template.html",
            controller: ['$rootScope', '$scope', '$subsetDialogs', function ($rootScope, $scope, $subsetDialogs) {
               //Open Subset Editor
               $scope.editSubset = function (dimension) {

                  var hierarchy = dimension.hierarchy;

                  var handler = function(subset, elements){
                
                     // subset.selected has what element was clicked
                     // dimension.filter will append every selected element
                     // if to workaround undefined value being by default
                     if( dimension.filter === undefined){
                        dimension.filter = subset.selected.alias;
                     }else{
                        dimension.filter +=  document.querySelector("#elementDelim").value + subset.selected.alias;
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

                  $subsetDialogs.open(instance, hierarchy.dimension, hierarchy.name, subset, handler);
                  
                };

            }],
            data: {
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
               exportSeparatorCSV: true,
               action: action // pass through the function declared above
            }
            
			
         });

      });

   };

}]);