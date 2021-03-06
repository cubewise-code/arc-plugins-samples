
arc.run(['$rootScope', function ($rootScope) {

    $rootScope.plugin("adminTasksSimple", "Admin Tasks Simple", "page", {
        menu: "tools",
        icon: "fa-briefcase",
        description: "This plugin can be used to create a simple list of TM1 Admin tasks",
        author: "Cubewise",
        url: "https://github.com/cubewise-code/arc-plugins-samples",
        version: "1.0.0"
    });

}]);

arc.directive("adminTasksSimple", function () {
    return {
        restrict: "EA",
        replace: true,
        scope: {
            instance: "=tm1Instance"
        },
        templateUrl: "__/plugins/admin-tasks-simple/template.html",
        link: function ($scope, element, attrs) {

        },
        controller: ["$scope", "$rootScope", "$http", "$tm1", "$translate", "$timeout", function ($scope, $rootScope, $http, $tm1, $translate, $timeout) {

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
                if (args.page == "adminTasksSimple" && args.instance == $scope.instance && args.name == null) {
                    // The page matches this one so close it
                    $rootScope.close(args.page, { instance: $scope.instance });
                }
            });

            $scope.$on("$destroy", function (event) {

            });


        }]
    };
});