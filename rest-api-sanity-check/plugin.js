
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

         $scope.methods = {
            "GET": "btn btn-success",
            "POST": "btn btn-primary",
            "PATCH": "btn btn-warning",
            "DELETE": "btn btn-danger"
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
               $scope.requestPending = 1;
               $scope.resetStatusAll();
               executeQueriesSync();
               executeQueriesAsync();
         };


         //for those which are not async/dependent:
         var executeQueriesSync = function () {
            item = $scope.requests[executeQueriesIndex];
            // console.debug(item.name + "'s index is " + item.dependencyIndex);
            if(item.isDependent) {
               if(item.checked) {       
                  resetStatus(item);
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
                           // console.info(result.data);
                        } else {
                           item.icon = "fa-exclamation-triangle"
                           item.queryStatus = 'warning';   
                           // console.warn("%o warning info:", result.data);  
                        }
                     } else {
                        item.icon = "fa-thin fa-times";
                        item.queryStatus = 'failed';
                        item.resultQuery = result.data.error;
                        item.message = result.data.error.message;
                        // console.error("%o error info:r", result.data);  
                        
                     }
                     var receiveDate = (new Date()).getTime();
                     item.responseTimeMs = receiveDate - sendDate;
                     $scope.globalRuntime = $scope.globalRuntime + item.responseTimeMs;
                     item.wasExecuted = true;
                     item.executing = false;
                     console.info(item);
                     setResultsCount(item);  
                     updateProgressBar();                           
                     tryNextItem();
                     tryToEnableButton();
                  });
               } else {
                  tryNextItem();
               };
            } else {
               tryNextItem();
            };

         };

         //running next query waiting for the current one to end
         var tryNextItem = function() {
            executeQueriesIndex++;
            if($scope.requests.length >= executeQueriesIndex + 1) {
               executeQueriesSync();
            };
         };

         //for those which are async/not-dependent:
         var executeOneQuery = function (item) {
            if(item.checked && !item.isDependent) {
                  var sendDate = (new Date()).getTime();
                  resetStatus(item);
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
                           // console.info(result.data);
                        } else {
                           item.icon = "fa-exclamation-triangle"
                           item.queryStatus = 'warning';   
                           // console.warn("%o warning info:", result.data);  
                        }
                     } else {
                        item.icon = "fa-thin fa-times";
                        item.queryStatus = 'failed';
                        item.resultQuery = result.data.error;
                        item.message = result.data.error.message;
                        // console.error("%o error info:r", result.data);  
                        
                     }
                     var receiveDate = (new Date()).getTime();
                     item.responseTimeMs = receiveDate - sendDate;
                     $scope.globalRuntime = $scope.globalRuntime + item.responseTimeMs;
                     item.wasExecuted = true;
                     item.executing = false;           
                     console.info(item);
                     setResultsCount(item);
                     tryToEnableButton();
                     updateProgressBar();
                  });
               };
            };
   
   
         var executeQueriesAsync = function (){
            /*requestPending set to 0 to disable the execution button
            we set globalRuntime to 0 to reset the global runtime*/
            //  $scope.requestPending = 0;
            $scope.globalRuntime = 0;
            _.each($scope.requests, function(item) {
               executeOneQuery(item)              
            });
         };


         var tryToEnableButton = function() {
            checkedItemsCount = 0;
            _.each($scope.requests, function(item) {
               if(item.checked == true) {
                  checkedItemsCount++;
                  executedItemsCount = $scope.successesResult + $scope.errorsResult + $scope.warningsResult;
               };
            });
            // console.debug("checked items: " + checkedItemsCount + " executed items: " + executedItemsCount);
            if(checkedItemsCount == executedItemsCount) {
               $scope.requestPending = 0;
               checkedItemsCount = 0;
            };
         };



         var updateProgressBar = function () {
            nbStepsDone++;
            $scope.stepsDone = Math.round(nbStepsDone / $scope.totalResult * 100);
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
               resetStatus(item);
            });
            $scope.globalRuntime = 0;
            executeQueriesIndex = 0;
            nbStepsDone = 0;
            $scope.stepsDone = 0;
            $scope.stepsDoneFormatted = 0;
            
         };

         $scope.setStatusFilter = function(text) { 
            if($scope.statusFilter == text) {
               $scope.statusFilter = null;
            } else {
               $scope.statusFilter = text;
            };
         };

         //check - uncheck query items
         var checkItem = function(item) {
            item.checked = true;
         };

         var uncheckItem = function(item) {
            item.checked = false;
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

         var checkAllItems = function() {
            _.each($scope.requests, function(item) {
               checkItem(item);
            });
         };


         var uncheckAllItems = function() {
            _.each($scope.requests, function(item) {
               uncheckItem(item);
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
                     if (JSON.stringify(itemBody).includes("MDX")) {
                        stringifiedMDX = JSON.stringify(itemBody.MDX).replace(",", ", \n").replace("ROWS", "ROWS \n").replace("WHERE", "\n WHERE").slice(1,-1);
                        $scope.resultBody = stringifiedMDX;
                        $scope.showBodyTabAsMDX = true;
                        console.log("He entrado");
                        $scope.bodyTitle = "MDX";
                     } else {
                        $scope.resultBody = itemBody;
                        console.log($scope.resultBody);
                        $scope.showBodyTabAsMDX = false;
                        $scope.bodyTitle = "Body";
                     }
                  } else if (item.method == "GET" || item.method == "PATCH") {
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
                  };

                  $scope.queryData = item;
                 
                  console.log($scope.queryData);
                  $scope.itemMethod = item.method;
               }],
            });
         };

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

         var methodBadgeType = function(item) {
            method = item.method;
            console.log(method);
            badgeType = $scope.methods[method];
            item.badgeType = "badge " + badgeType + " d-inline-flex align-items-center text-left";
            console.log(item.badgeType);
         };

         //loads the requests
         var loadSettingsFile = function () {
            $scope.requests = [];
            $scope.values.settingsFileJSONError = false;
            $http.get("__/plugins/rest-api-sanity-check/requests.json").then(function (result) {
               if (result.status === 200) {
                  $scope.values.settingFilesFound = true;
                  $scope.requests = result.data;            
                  checkAllItems();
                  for (let index = 0; index < $scope.requests.length; index++) {
                     const item = $scope.requests[index];
                     methodBadgeType(item);
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