
// Uncomment the code arc.run.. below to enable this plugin



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
      controller: ["$scope", "$rootScope", "$http", "$tm1", "$translate", "$timeout", function ($scope, $rootScope, $http, $tm1, $translate, $timeout) {

         //Define variables
         $scope.defaults = {};
         $scope.selections = {};
         $scope.lists = {
            columns : [
               {desc: ""},
               {desc: "Method"},
               {desc: "Query"}, 
               {desc: "Status Expected"},
               {desc: "Status Result"},
            ]
         };
         $scope.values = {};

         //Functions
         var loadSettingsFile = function () {
            $scope.requests = [];
            $scope.values.settingsFileJSONError = false;
            $http.get("__/plugins/rest-api-sanity-check/requests.json").then(function (result) {
               if (result.status === 200) {
                  $scope.values.settingFilesFound = true;
                  $scope.requests = result.data;
                  executeAllQueries();
                  console.log($scope.requests)
               } else {
                  $scope.values.settingFilesFound = false;
                  $scope.values.settingsFileErrorMessage = result.data;
               }
            }, function (error) {
               $scope.values.settingsFileJSONError = true;
            }
            );
         };

         //Execute Query
         var executeOneQuery = function (item) {
            item.executing = true;
            var restApiQuery = "/" + item.query;
            var sendDate = (new Date()).getTime();
            $tm1.async($scope.instance, item.method, restApiQuery, item.body).then(function (result) {
               item.statusResult = result.status;
               if (result.status == 200 || result.status == 201 || result.status == 204) {
                  item.queryStatus = 'success';
                  item.resultQuery = result.data;
                  item.message = null;
                  if( item.statusResult == item.statusCodeExpected){
                     item.icon = "fa-check-circle"
                  } else {
                     item.icon = "fa-exclamation-triangle"
                  }
               } else {
                  item.queryStatus = 'failed';
                  item.resultQuery = result.data.error;
                  item.message = result.data.error.message;
               }
               var receiveDate = (new Date()).getTime();
               item.responseTimeMs = receiveDate - sendDate;
               item.executing = false;
            });
         };

         var executeAllQueries = function (){
            _.each($scope.requests, function (item, key) {
               executeOneQuery(item);
            });
         };

         var init = function () {
            loadSettingsFile();
         }

         init()


         //Trigger an event after the login screen
         $scope.$on("login-reload", function (event, args) {

         });

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