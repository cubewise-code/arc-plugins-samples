arc.run(['$rootScope', function ($rootScope) {

   $rootScope.plugin("arcSanityCheck", "TM1 REST API Sanity Check (Sample)", "page", {
      menu: "tools",
      icon: "fa-check-circle",
      description: "Runs a set of TM1 REST API requests against the instance and checks each one returns the expected status",
      author: "Cubewise",
      url: "https://github.com/cubewise-code/arc-plugins-samples/tree/master/rest-api-sanity-check",
      version: "2.0.0"
   });

}]);

arc.run(["$dialogs", function ($dialogs) {

   $dialogs.registerDialog("arcSanityCheckDetailsDialog", {
      title: "Request details",
      directive: "arcSanityCheckDetails",
      icon: "fa-check-circle",
      size: "large",
      okButtonClass: "d-none",
      cancelButtonLabel: "CLOSE"
   });

}]);

arc.filter("humanizeDuration", [function () {
   return function (value, options) {
      return humanizeDuration (value, options);
   }
}]);


arc.directive("arcSanityCheckDetails", function () {
   return {
      restrict: "EA",
      replace: true,
      scope: {
         data: "=arcModelData",
         options: "=arcOptions",
         dialog: "=arcDialog"
      },
      templateUrl: "__/plugins/rest-api-sanity-check/m-request-body.html",
      controller: ["$scope", "$rootScope", function ($scope, $rootScope) {

         var item = $scope.data.item;
         var itemBody = item.body;
         $scope.queryStatus = item.queryStatus;
         if (item.method == "POST") {
            if (JSON.stringify(itemBody).includes("MDX")) {
               var stringifiedMDX = JSON.stringify(itemBody.MDX).replace(",", ", \n").replace("ROWS", "ROWS \n").replace("WHERE", "\n WHERE").slice(1, -1);
               $scope.resultBody = stringifiedMDX;
               $scope.showBodyTabAsMDX = true;
               $scope.bodyTitle = "MDX";
            } else {
               $scope.resultBody = itemBody;
               $scope.showBodyTabAsMDX = false;
               $scope.bodyTitle = "Body";
            };
         } else if (item.method == "GET" || item.method == "PATCH") {
            if (item.method == "PATCH") {
               $scope.resultBody = itemBody;
               $scope.bodyTitle = "Body";
            };
            if (item.resultQuery.value) {
               for (let index = 0; index < item.resultQuery.value.length; index++) {
                  const element = item.resultQuery.value[index];
                  if (element.Rules != null) {
                     element.Rules = element.Rules.substring(0, 100) + "...";
                  };
               };
            } else if (item.resultQuery.Rules != null) {
               item.resultQuery.Rules = item.resultQuery.Rules.substring(0, 100) + "...";
            };
         };

         $scope.queryData = item.resultQuery;
         $scope.itemMethod = item.method;

         $scope.editorLoaded = function (_editor) {
            // Initialise the editor settings
            _editor.setTheme($rootScope.uiPrefs.editorTheme);
            _editor.getSession().setMode("ace/mode/mdx");
            _editor.getSession().setOptions({ tabSize: $rootScope.uiPrefs.editorTabSpaces, useSoftTabs: true });
            _editor.$blockScrolling = Infinity;
            _editor.setFontSize($rootScope.uiPrefs.fontSize);
            _editor.setShowPrintMargin(false);
            _editor.getSession().setUseWrapMode($rootScope.uiPrefs.editorWrapLongLines);
         };

      }]
   };
});

arc.directive("arcSanityCheck", function () {
   return {
      restrict: "EA",
      replace: true,
      scope: {
         instance: "=tm1Instance"
      },
      templateUrl: "__/plugins/rest-api-sanity-check/template.html",
      link: function ($scope, element, attrs) {

      },
      controller: ["$scope", "$rootScope", "$http", "$tm1", "$translate", "$timeout", "$dialogs", function ($scope, $rootScope, $http, $tm1, $translate, $timeout, $dialogs) {

         // The sample creates and deletes this dimension, so it must not be one that is already on the instance
         var TEST_NAME = "zzArcSanityCheck";

         //Variables area
         $scope.defaults = {};
         $scope.selections = {};
         $scope.lists = {
            columns : [
               {desc: "#", align:"center"},
               {desc: "Method", align:"center"},
               {desc: "Query", align:"left"},
               {desc: "Status Expected", align:"center"},
               {desc: "Result", align:"center"},
               {desc: "Runtime", align:"center"}, 
            ],
         };

         $scope.methodsBadgeType = {
            "GET": "btn-success",
            "POST": "btn-primary",
            "PATCH": "btn-warning",
            "DELETE": "btn-danger"
         };


         $scope.checkedRequests = [];
         $scope.values = {};
         $scope.goodHttpStatus = [200, 201, 204];
         $scope.successesResult = 0;
         $scope.warningsResult = 0;
         $scope.errorsResult = 0;
         $scope.totalResult = 0;
         $scope.statusFilter = null;
         $scope.checkActivated= true;
         $scope.blank = "";
         $scope.isProcessing = false;
         $scope.globalRuntime = 0;
         executeQueriesIndex = 0;
         checkedItemsCount = 0;
         executedItemsCount = 0;
         $scope.successBar = 0;
         $scope.warningBar = 0;
         $scope.errorsBar = 0;

         
         // querys execution
         // dependent queries must be placed sequencially before not-dependent ones in request.json
         $scope.executeQueries = function() {
               var createsTestObjects = _.some($scope.checkedRequests, function (item) {
                  return item.isDependent;
               });
               if (!createsTestObjects) {
                  startQueries();
                  return;
               }
               // Never touch an object that is already there
               $http.get(encodeURIComponent($scope.instance) + "/Dimensions('" + TEST_NAME + "')?$select=Name").then(function (result) {
                  if (result.status == 200) {
                     $dialogs.error("Sanity check not started", "A dimension called '" + TEST_NAME + "' already exists on this instance. The sample creates and deletes a dimension with that name, so it was not run. Rename or delete that dimension first.", "medium");
                     return;
                  }
                  $dialogs.confirm("The sanity check creates a dimension called '" + TEST_NAME + "' on " + $scope.instance + ", reads it and deletes it again. Run it?", startQueries);
               });
         };

         var startQueries = function () {
               $scope.requestPending = 1;
               $scope.resetStatusAll();
               executeQueries();           
         };

         var executeQueries = function (){
            /*requestPending set to 0 to disable the execution button
            we set globalRuntime to 0 to reset the global runtime*/
            //  $scope.requestPending = 0;
            $scope.globalRuntime = 0;
            
            var firstItem = $scope.checkedRequests[0];
            if (firstItem.isDependent) {
               executeOneQuery(firstItem);
            };
            if(executeQueriesIndex >= 0) {
               _.each($scope.checkedRequests, function(item) {
                  if(!item.isDependent) {
                  executeOneQuery(item)
                  };           
               });
            };
         };

         //running next query waiting for the current one to end
         var tryItem = function(item) {
            executeOneQuery(item);
         };

         var executeOneQuery = function (item) {
            var nextItem = $scope.requests[item.index+1];
            if (!item.checked && nextItem != undefined) {
               executeOneQuery(nextItem);
            } else if (item.checked) {
               var sendDate = (new Date()).getTime();           
               var restApiQuery = "/" + item.query;
               var sendDate = (new Date()).getTime();
               $tm1.async($scope.instance, item.method, restApiQuery, item.body).then(function (result) {
                  item.executing = true;
                  item.statusResult = result.status;
                  if ($scope.goodHttpStatus.includes(result.status)) {
                     item.resultQuery = result.data;
                     item.message = null;
                     if( item.statusResult == item.statusCodeExpected){
                        var statusResult = "success"
                        // item.icon = "fa-check-circle"
                        item.queryStatus = statusResult;
                     } else {
                        var statusResult = "warning"
                        item.icon = "fa-exclamation-triangle"
                        item.queryStatus = statusResult;     
                     }
                  } else {
                     var statusResult = "error"
                     item.icon = "fa-thin fa-times-circle";
                     item.queryStatus = 'failed';
                     item.resultQuery = result.data ? result.data.error : null;
                     item.message = (result.data && result.data.error) ? result.data.error.message : null;
                  };
                  
                  var receiveDate = (new Date()).getTime();
                  if (item.queryStatus != "error") {
                     item.responseTimeMs = receiveDate - sendDate;
                     $scope.globalRuntime = $scope.globalRuntime + item.responseTimeMs;
                  };
                  item.wasExecuted = true;
                  item.executing = false;
                  if(item.method != "DELETE") {
                     item.seeDetails = "pointer";
                  };
                  setResultsCount(item);
                  updateProgressBar(item.queryStatus);
                  tryToEnableButton();
                  if (item.isDependent && item.queryStatus == "failed") {
                     // Do not carry on with steps that depend on this one
                     $scope.requestPending = 0;
                     $dialogs.error("Sanity check stopped", "'" + item.name + "' failed, so the steps that depend on it were not run. The dimension '" + TEST_NAME + "' may still be on the instance, delete it before running again.", "medium");
                  } else if (item.isDependent && nextItem != undefined && nextItem.isDependent) {
                     tryItem(nextItem);
                  };
               });
            }
         };
            
         var tryToEnableButton = function() {
            if($scope.stepsDone == 100) {
               $scope.requestPending = 0;
            };
         };

         var updateProgressBar = function (itemResult) {

            if (itemResult == "success") {
               nbSuccessfulStepsDone++
               $scope.successfulStepsDone = nbSuccessfulStepsDone / $scope.checkedRequests.length * 100;
               $scope.successfulStepsDoneFormatted = $scope.successfulStepsDone + "%";
            } else if (itemResult == "warning") {
               nbWarnStepsDone++
               $scope.warnStepsDone = nbWarnStepsDone / $scope.checkedRequests.length * 100;
               $scope.warnStepsDoneFormatted = $scope.warnStepsDone + "%";            
            } else {
               nbErrorStepsDone++
               $scope.errorStepsDone = nbErrorStepsDone / $scope.checkedRequests.length * 100;
               $scope.errorStepsDoneFormatted = $scope.errorStepsDone + "%";   
            };

            nbStepsDone++;
            $scope.stepsDone = Math.round(nbStepsDone / $scope.checkedRequests.length * 100);
            $scope.stepsDoneFormatted = $scope.stepsDone +"%";
         };

         //Functions
         //Set the count of successes, warnings and errors
         var setResultsCount = function(item) {
            if(item.queryStatus == "success") {
               $scope.successesResult++;
            } else if (item.queryStatus == "warning") {
               $scope.warningsResult++;
            } else if (item.queryStatus == "failed") {
               $scope.errorsResult++;
            };
         };

         //Resets the query status to the initial one
         var resetStatus = function(item) {
            // if (["success", "warning", "failed"].includes(item.queryStatus)) {
               if (item.queryStatus == "success") {
                  $scope.successesResult--;
               } else if (item.queryStatus == "warning") {
                  $scope.warningsResult--;
               } else if (item.queryStatus == "failed") {
                  $scope.errorsResult--;
               };
               item.queryStatus = null;
               item.icon = null;
               item.statusResult = null;
               item.wasExecuted = false;
               item.seeDetails = "default";
         };

         $scope.resetStatusAll = function() {
            _.each($scope.requests, function(item) {
               resetStatus(item);
            });
            nbStepsDone = 0;
            nbErrorStepsDone = 0;
            nbSuccessfulStepsDone = 0;
            nbWarnStepsDone = 0;
            $scope.globalRuntime = 0;
            executeQueriesIndex = 0;
            $scope.stepsDone = 0;
            $scope.successfulStepsDoneFormatted = 0;
            $scope.warnStepsDoneFormatted = 0;
            $scope.errorStepsDoneFormatted = 0;
            
         };

         $scope.setStatusFilter = function(text) { 
            if($scope.statusFilter == text) {
               $scope.statusFilter = null;
            } else {
               $scope.statusFilter = text;
            };
         };

         //check - uncheck query items
         $scope.checkItem = function(item) {
            item.checked = true;
            $scope.checkedRequests = $scope.requests.filter(item => item.checked);
         };

         var checkAllItems = function() {
            _.each($scope.requests, function(item) {
               $scope.checkItem(item);
            });
         };


         $scope.uncheckItem = function(item) {
            item.checked = false;
            $scope.checkedRequests = $scope.requests.filter(item => item.checked);
         };

         var uncheckAllItems = function() {
            _.each($scope.requests, function(item) {
               $scope.uncheckItem(item);
            });
         };

         $scope.checkUncheckAll = function() {
            var uncheckedItems = $scope.requests.filter(item => !item.checked);
               if(uncheckedItems.length > 0)  {
                  checkAllItems();
                  $scope.checkActivated = true;
               } else {
                  uncheckAllItems();
                  $scope.checkActivated = false;
               };
            };


         //See Details PopUp
         $scope.seeDetails = function (item) {
            $dialogs.showDialog("arcSanityCheckDetailsDialog", { item: item });
         };

         var methodBadgeType = function(item) {
            var method = item.method;
            var badgeType = $scope.methodsBadgeType[method];
            item.badgeType = "badge " + badgeType;
         };


         // The first cube of the instance and its first dimension, used by the read-only requests
         var getSampleObjects = function () {
            return $http.get(encodeURIComponent($scope.instance) + "/Cubes?$select=Name&$top=1&$filter=indexof(Name,'}') eq -1").then(function (cubes) {
               if (cubes.status != 200 || cubes.data.value.length == 0) {
                  return null;
               }
               var cube = cubes.data.value[0].Name;
               return $http.get(encodeURIComponent($scope.instance) + "/Cubes('" + cube.replace(/'/g, "''") + "')/Dimensions?$select=Name&$top=1").then(function (dims) {
                  if (dims.status != 200 || dims.data.value.length == 0) {
                     return null;
                  }
                  return { cube: cube, dimension: dims.data.value[0].Name };
               });
            });
         };

         var fillPlaceholders = function (value, sample) {
            if (_.isString(value)) {
               return value.replace(/\{cube\}/g, sample.cube.replace(/'/g, "''")).replace(/\{dimension\}/g, sample.dimension.replace(/'/g, "''"));
            } else if (_.isArray(value)) {
               return _.map(value, function (v) { return fillPlaceholders(v, sample); });
            } else if (_.isObject(value)) {
               return _.mapValues(value, function (v) { return fillPlaceholders(v, sample); });
            }
            return value;
         };

         //loads the requests
         var loadSettingsFile = function () {
            $scope.requests = [];
            $scope.values.settingsFileJSONError = false;
            $http.get("__/plugins/rest-api-sanity-check/requests.json").then(function (result) {
               if (result.status === 200) {
                  $scope.values.settingFilesFound = true;
                  getSampleObjects().then(function (sample) {
                     var requests = result.data;
                     if (sample) {
                        requests = fillPlaceholders(requests, sample);
                     } else {
                        // An instance with no cubes: skip the requests that need one
                        requests = _.reject(requests, function (item) {
                           return JSON.stringify(item).indexOf("{cube}") >= 0;
                        });
                     }
                     $scope.requests = requests;
                     checkAllItems();
                     for (let index = 0; index < $scope.requests.length; index++) {
                        const item = $scope.requests[index];
                        methodBadgeType(item);
                        item.index = index;
                        $scope.totalResult ++;
                     };
                  });
               } else {
                  $scope.values.settingFilesFound = false;
                  $scope.values.settingsFileErrorMessage = result.data;
               }
            }, function (error) {
               $scope.values.settingsFileJSONError = true;
            }
            );     
         };
          
         var init = function () {
            loadSettingsFile();
         };

         //Initial executions:
         init();
     
          
         //Trigger an event after the login screen
         $scope.$on("login-reload", function (event, args) {

         });

         
         //Close the tab
         $scope.$on("close-tab", function (event, args) {
            // Event to capture when a user has clicked close on the tab
            if (args.page == "arcSanityCheck" && args.instance == $scope.instance) {
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