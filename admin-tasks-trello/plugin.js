
arc.run(['$rootScope', function ($rootScope) {

    $rootScope.plugin("adminTasksTrello", "Admin Tasks Trello", "page", {
        menu: "tools",
        icon: "fa-trello",
        description: "This plugin can be used to create TM1 administrators tasks which look like Trello",
        author: "Cubewise",
        url: "https://github.com/cubewise-code/arc-plugins-samples",
        version: "1.0.0"
    });

}]);

arc.directive("adminTasksTrello", function () {
    return {
        restrict: "EA",
        replace: true,
        scope: {
            instance: "=tm1Instance"
        },
        templateUrl: "__/plugins/admin-tasks-trello/template.html",
        link: function ($scope, element, attrs) {

        },
        controller: ["$scope", "$rootScope", "$http", "$tm1", "$translate", "$timeout", function ($scope, $rootScope, $http, $tm1, $translate, $timeout) {

            // Store the active tab index
            $scope.selections = {
                chore: 'Save Data - Morning',
                process: 'Bedrock.Server.Wait',
                cube: 'General Ledger',
                instance: 'Canvas Sample'
            };

            $scope.link = {
                openView: 'cube/view/'+ $scope.instance,
                openTI: 'cube/view/'+ $scope.instance
            };

            $scope.adminTasks = [];
            $http.get("__/plugins/admin-tasks-trello/admin-tasks.json").then(function (value) {
               $scope.adminTasks = value.data;
           });

            $scope.calculatePercentage = function (tab) {
               var nbStepsOpen = 0 ;
               var nbStepsTotal = 0 ;
               for(var step in tab.content){
                    nbStepsTotal ++;
                    if(tab.content[step].open == false){
                        nbStepsOpen ++;
                    }
               } 
               tab.stepPercentage = parseInt(nbStepsOpen / nbStepsTotal * 100);
            };

            $scope.executeChore = function (name) {
                $tm1.choreExecute($scope.instance, name);
            };

            $scope.executeProcess = function (name) {
                $tm1.processExecute($scope.instance, name);
            };          

            $scope.$on("login-reload", function (event, args) {

            });

            $scope.$on("close-tab", function (event, args) {
                // Event to capture when a user has clicked close on the tab
                if (args.page == "adminTasksTrello" && args.instance == $scope.instance && args.name == null) {
                    // The page matches this one so close it
                    $rootScope.close(args.page, { instance: $scope.instance });
                }
            });

            $scope.$on("$destroy", function (event) {

            });


        }]
    };
});