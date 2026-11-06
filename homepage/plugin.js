
arc.run(['$rootScope', function ($rootScope) {

    $rootScope.plugin("overviewButton", "Home", "page", {
        menu: "tools",
        icon: "fa-home",
        description: "A home page for an instance with shortcuts to cubes, dimensions, processes, chores and the server pages",
        author: "Cubewise",
        url: "https://github.com/cubewise-code/arc-plugins-samples/tree/master/homepage",
        version: "2.0.0"
    });

}]);

arc.directive("overviewButton", function () {
    return {
        restrict: "EA",
        replace: true,
        scope: {
            instance: "=tm1Instance"
        },
        templateUrl: "__/plugins/homepage/template.html",
        link: function ($scope, element, attrs) {

        },
        controller: ["$scope", "$rootScope", "$http", "$tm1", "$translate", "$timeout", "$tabs", function ($scope, $rootScope, $http, $tm1, $translate, $timeout, $tabs) {

            // Open a page the same way the Arc menu does
            $scope.open = function (item) {
                var params = { instance: $scope.instance };
                if (item.cube !== undefined) {
                    params.cube = item.cube;
                }
                $tabs.open(item.page, params);
            };

            // Store the active tab index
            $scope.selections = {
                activeTab: 0,
                queryCounter: 0,
                fromController: 'From Controller'
            };

            $scope.options = {
                tm1ObjectsOpen : true,
                administrationOpen : true,
                pluginsOpen : true
            }

            $scope.tm1Objects = [
                { key: 'Cubes', description: 'See all cubes',value: '', icon: 'cubes', class: 'object', page: 'cubes' },
                { key: 'Dimensions', description: 'See all dimensions',value: '', icon: 'dimensions', class: 'object', page: 'dimensions', cube: '' },
                { key: 'Processes', description: 'See all Processes',value: '', icon: 'processes', class: 'object', page: 'processes' },
                { key: 'Chores', description: 'See all chores',value: '', icon: 'chores', class: 'object',page: 'chores' }
                ]

            $scope.configurations = [
                { key: 'Users', description: 'All TM1 users and their security',value: '', icon: 'fa-user', class: 'admin',page: 'cubewiseSecurity' },
                { key: 'Configuration', description: 'tm1s.cfg settings',value: '', icon: 'configuration', class: 'admin',page: 'cubewiseConfiguration' },
                { key: 'Server Logs', description: 'TM1 Server Logs',value: '', icon: 'fa-list-alt', class: 'admin',page: 'cubewiseServerLogs' },
                { key: 'Sessions', description: 'Sessions and threads',value: '', icon: 'fa-users', class: 'admin',page: 'cubewiseSessions' }
             ]

            $scope.plugins = [
                { key: 'MDX Lab', description: 'Write and test MDX queries',value: '', icon: 'fa-table', class: 'plugins',page: 'cubewiseMdxLab' }
            ]

            $scope.$on("login-reload", function (event, args) {

            });

            // GET USERS COUNT
            $scope.getUsersCount = function () {
                $http.get(encodeURIComponent($scope.instance) + "/Users/$count").then(function (value) {
                    if (value.status == 200) {
                        $scope.configurations[0].value = value.data;
                    }
                });
            };
            $scope.getUsersCount();
            // GET CUBE COUNT
            $scope.getCubesCount = function () {
               var query = "";
               var queryAll = "/Cubes/$count";
               var queryWithoutControlObjects = "/Cubes/$count?$filter=indexof(Name,'}') eq -1";
               if ($rootScope.uiPrefs.controlObjects) {
                  query = queryAll;
               } else {
                  query = queryWithoutControlObjects;
               }
                $http.get(encodeURIComponent($scope.instance) + query).then(function (cubesList) {
                    if (cubesList.status == 200) {
                        $scope.tm1Objects[0].value = cubesList.data;
                    }
                });
            };
            $scope.getCubesCount();

            // GET DIMENSIONS COUNT
            $scope.getDimensionsCount = function () {
               var query = "";
               var queryAll = "/Dimensions/$count";
               var queryWithoutControlObjects = "/Dimensions/$count?$filter=indexof(Name,'}') eq -1";
               if ($rootScope.uiPrefs.controlObjects) {
                  query = queryAll;
               } else {
                  query = queryWithoutControlObjects;
               }
                $http.get(encodeURIComponent($scope.instance) + query).then(function (dimensionsList) {
                    if (dimensionsList.status == 200) {
                        $scope.tm1Objects[1].value = dimensionsList.data;
                    }
                });
            };
            $scope.getDimensionsCount();

            // GET PROCESSES COUNT
            $scope.getProcessesCount = function () {
               var query = "";
               var queryAll = "/Processes/$count";
               var queryWithoutControlObjects = "/Processes/$count?$filter=indexof(Name,'}') eq -1";
               if ($rootScope.uiPrefs.controlObjects) {
                  query = queryAll;
               } else {
                  query = queryWithoutControlObjects;
               }
                $http.get(encodeURIComponent($scope.instance) + query).then(function (value) {
                    if (value.status == 200) {
                        $scope.tm1Objects[2].value = value.data;
                    }
                });
            };
            $scope.getProcessesCount();

            // GET CHORES COUNT
            $scope.getChoresCount = function () {
                $http.get(encodeURIComponent($scope.instance) + "/Chores/$count").then(function (value) {
                    if (value.status == 200) {
                        $scope.tm1Objects[3].value = value.data;
                    }
                });
            };
            $scope.getChoresCount();

            $scope.$on("close-tab", function (event, args) {
                // Event to capture when a user has clicked close on the tab
                if (args.page == "overviewButton" && args.instance == $scope.instance) {
                    // The page matches this one so close it
                    $rootScope.close(args.page, args);
                }
            });

            $scope.$on("$destroy", function (event) {

            });


        }]
    };
});