arc.run(['$rootScope', function ($rootScope) {

   $rootScope.plugin("arcSanityCheck", "TM1 REST API Sanity Check", "page", {
      menu: "tools",
      icon: "fa-adjust",
      description: "This plugin can be used as a starting point for building new page plugins",
      author: "Cubewise",
      url: "https://github.com/cubewise-code/arc-plugins",
      version: "1.0.0"
   });

}]);



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
      controller: ["$scope", "$rootScope", "$http", "$tm1", "$translate", "$timeout", "ngDialog", function ($scope, $rootScope, $http, $tm1, $translate, $timeout, ngDialog) {

         //Variables area
         $scope.defaults = {};
         $scope.selections = {};
         $scope.lists = {
            columns : [
               {desc: "#", align:"center"},
               {desc: ""},
               {desc: "Method", align:"center"},
               {desc: "Status Expected", align:"center"},
               {desc: "Status Result", align:"center"},
               {desc: "Query", align:"left"},
               {desc: "See Details", align:"center"},
               {desc: "Runtime", align:"center"}, 
            ],
         };

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


         
         // querys execution    
         $scope.executeQueries = function() {
               $scope.resetStatusAll();
               $scope.requestPending = 1;
               $scope.executeQueriesSync();
               $scope.executeQueriesAsync();
         };


         //for those which are not async:
         $scope.executeQueriesSync = function () {
            item = $scope.requests[executeQueriesIndex];
            console.debug(item.name + "'s index is " + item.dependencyIndex);
            if(item.isDependent) {  
               if(item.checked) {       
                  $scope.resetStatus(item);
                  item.executing = true;
                  var restApiQuery = "/" + item.query;
                  var sendDate = (new Date()).getTime();
                  $tm1.async($scope.instance, item.method, restApiQuery, item.body).then(function (result) {     
                     item.statusResult = result.status;
                     if ($scope.goodHttpStatus.includes(result.status)) {
                        item.resultQuery = result.data;
                        item.message = null;
                        if( item.statusResult == item.statusCodeExpected){
                           item.icon = "fa-check-circle"
                           item.queryStatus = 'success';
                           console.info(result.data);
                        } else {
                           item.icon = "fa-exclamation-triangle"
                           item.queryStatus = 'warning';   
                           console.warn("%o warning info:", result.data);  
                        }
                     } else {
                        item.icon = "fa-thin fa-times";
                        item.queryStatus = 'failed';
                        item.resultQuery = result.data.error;
                        item.message = result.data.error.message;
                        console.error("%o error info:r", result.data);  
                        
                     }
                     var receiveDate = (new Date()).getTime();
                     item.responseTimeMs = receiveDate - sendDate;
                     $scope.globalRuntime = $scope.globalRuntime + item.responseTimeMs;
                     item.wasExecuted = true;
                     item.executing = false;
                     $scope.setResultsCount(item);                             
                     tryNextItem();
                     tryToEnableButton();
                     // something weird happening here but doesn't look to have an impact on the plugin
                     // console.log(item);
                  });
               } else {
                  tryNextItem();
               };
            } else {
               tryNextItem();
            };

         };

         //running next query waiting for the current one to end
         tryNextItem = function() {
            executeQueriesIndex++;
            if($scope.requests.length >= executeQueriesIndex + 1) {
               $scope.executeQueriesSync();
            };
         };

         //for those which are async:
         $scope.executeOneQuery = function (item) {
            if(item.checked && !item.isDependent) {
                  // $scope.requestPending++;
                  var sendDate = (new Date()).getTime();
                  $scope.resetStatus(item);
                  item.executing = true;
                  var restApiQuery = "/" + item.query;
                  var sendDate = (new Date()).getTime();
                  $tm1.async($scope.instance, item.method, restApiQuery, item.body).then(function (result) {
                     item.statusResult = result.status;
                     if ($scope.goodHttpStatus.includes(result.status)) {
                        item.resultQuery = result.data;
                        item.message = null;
                        if( item.statusResult == item.statusCodeExpected){
                           item.icon = "fa-check-circle"
                           item.queryStatus = 'success';
                           console.info(result.data);
                        } else {
                           item.icon = "fa-exclamation-triangle"
                           item.queryStatus = 'warning';   
                           console.warn("%o warning info:", result.data);  
                        }
                     } else {
                        item.icon = "fa-thin fa-times";
                        item.queryStatus = 'failed';
                        item.resultQuery = result.data.error;
                        item.message = result.data.error.message;
                        console.error("%o error info:r", result.data);  
                        
                     }
                     var receiveDate = (new Date()).getTime();
                     item.responseTimeMs = receiveDate - sendDate;
                     $scope.globalRuntime = $scope.globalRuntime + item.responseTimeMs;
                     item.wasExecuted = true;
                     item.executing = false;
                     $scope.setResultsCount(item);
                     console.info(item);
                     tryToEnableButton();
                     // $scope.requestPending--;
                  });
               };
            };
   
   
            $scope.executeQueriesAsync = function (){
               /*requestPending set to 0 to disable the execution button
               we set globalRuntime to 0 to reset the global runtime*/
               //  $scope.requestPending = 0;
               $scope.globalRuntime = 0;
               _.each($scope.requests, function(item) {
                  $scope.executeOneQuery(item)              
               });
            };


         tryToEnableButton = function() {
            checkedItemsCount = 0;
            _.each($scope.requests, function(item) {
               if(item.checked == true) {
                  checkedItemsCount++;
                  executedItemsCount = $scope.successesResult + $scope.errorsResult + $scope.warningsResult;
               };
            });
            console.debug("checked items: " + checkedItemsCount + " executed items: " + executedItemsCount);
            if(checkedItemsCount == executedItemsCount) {
               $scope.requestPending = 0;
               checkedItemsCount = 0;
            };
         };




         //Functions

         //Set the count of successes, warnings and errors
         $scope.setResultsCount = function(item) {
            if(item.queryStatus == "success") {
               $scope.successesResult++;
            } else if (item.queryStatus == "warning") {
               $scope.warningsResult++;
            } else if (item.queryStatus == "failed") {
               $scope.errorsResult++;
            };
         };

         //Resets the query status to the initial one
         $scope.resetStatus = function(item) {
            if (["success", "warning", "failed"].includes(item.queryStatus)) {
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
            };
         };

         $scope.resetStatusAll = function() {
            _.each($scope.requests, function(item) {
               $scope.resetStatus(item);
            });
            $scope.globalRuntime = 0;
            executeQueriesIndex = 0;
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
         };

         $scope.uncheckItem = function(item) {
            item.checked = false;
         };

         $scope.checkUncheckAll = function() {
            var uncheckedItems = $scope.requests.filter(item => !item.checked);
               if(uncheckedItems.length > 0)  {
                  $scope.checkAllItems();
                  $scope.checkActivated = true;
               } else {
                  $scope.uncheckAllItems();
                  $scope.checkActivated = false;
               };
            };

         $scope.checkAllItems = function() {
            _.each($scope.requests, function(item) {
               $scope.checkItem(item);
            });
         };


         $scope.uncheckAllItems = function() {
            _.each($scope.requests, function(item) {
               $scope.uncheckItem(item);
            });
         };

         //See Details PopUp
         $scope.seeDetails = function (item) {
            var dialog = ngDialog.open({
               className: "ngdialog-theme-default large",
               template: "__/plugins/rest-api-sanity-check/m-request-body.html",
               name: "Instances",
               scope: $scope,
               controller: ['$rootScope', '$scope', function ($rootScope, $scope) {
                  if (item.method == "POST") {
                     itemBody = item.body;
                     dataWithoutBody = item.body = "see body on the body tab";
                     if (JSON.stringify(itemBody).includes("MDX")) {
                        stringifiedMDX = JSON.stringify(itemBody);
                        $scope.resultJSON = stringifiedMDX;
                     } else {
                        $scope.resultJSON = JSON.stringify(itemBody, false, 2);
                     }
                     // $scope.queryData = JSON.stringify(item, false, 2);
                  } else if (item.method == "GET" || item.method == "PATCH") {
                     // avoidRulesMessage = 'Avoiding showing too much code here';
                     if(item.resultQuery.value) {
                        for (let index = 0; index < item.resultQuery.value.length; index++) {
                           const element = item.resultQuery.value[index];
                           if (element.Rules != null) {
                              shortenedRule = element.Rules.substring(0, 100) + "...";
                              element.Rules = shortenedRule;
                           };
                        };
                     } else if (item.resultQuery.Rules != null) {
                           const element = item.resultQuery;
                           if (element.Rules != null) {
                              shortenedRule = element.Rules.substring(0, 100) + "...";
                              element.Rules = shortenedRule;
                           };
                     };
                     // $scope.queryData = JSON.stringify(item.resultQuery, false, 2);  
                  };
                  $scope.queryData = JSON.stringify(item, false, 2);
                  $scope.itemMethod = item.method;
               }],
            });
         };

         //loads the requests
         var loadSettingsFile = function () {
            $scope.requests = [];
            $scope.values.settingsFileJSONError = false;
            $http.get("__/plugins/rest-api-sanity-check/requests.json").then(function (result) {
               if (result.status === 200) {
                  $scope.values.settingFilesFound = true;
                  $scope.requests = result.data;            
                  $scope.checkAllItems();
                  for (let index = 0; index < $scope.requests.length; index++) {
                     const item = $scope.requests[index];
                     const indexToShow = index+1;
                     item.index = indexToShow;
                     $scope.totalResult ++;
                  }
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

         
         //Reloads the page, not using it at the moment
         $scope.reload = function() {
               console.log("loading...");
               location.reload(true);
           };


         //Close the tab
         $scope.$on("close-tab", function (event, args) {
            // Event to capture when a user has clicked close on the tab
            if (args.page == "arcSanityCheck" && args.instance == $scope.instance && args.name == null) {
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