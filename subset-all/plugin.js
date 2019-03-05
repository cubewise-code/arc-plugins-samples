
arc.run(['$rootScope', function ($rootScope) {

    $rootScope.plugin("cubewiseSubset", "All Subsets", "page", {
        menu: "tools",
        icon: "subset",
        description: "This plugin can be used to search any TM1 objects",
        author: "Cubewise",
        url: "https://github.com/cubewise-code/arc-plugins",
        version: "1.0.0"
    });

}]);

arc.directive("cubewiseSubset", function () {
    return {
        restrict: "EA",
        replace: true,
        scope: {
            instance: "=tm1Instance"
        },
        templateUrl: "__/plugins/subset-all/template.html",
        link: function ($scope, element, attrs) {

        },
        controller: ["$scope", "$rootScope", "$http", "$tm1", "$translate", "$timeout", "ngDialog",function ($scope, $rootScope, $http, $tm1, $translate, $timeout,ngDialog) {

            // Store the active tab index
            $scope.selections = {
                dimension: '',
                hierarchy: '',
                subset: ''
            };

            $scope.options = {
                seeSubsetsPerView: false,
                seeViewsPerSubset: false,
                seeAllSubsets: false,
                searchBySubset: true
            }

            $scope.lists = {
                dimensions: [],
                hierarchies: [],
                subsets: [],
                cubes: [],
                viewsAndSubsetsUnstructured: [],
                viewsAndSubsetsStructured: [],
                allSubsetsPerView: [],
                allViewsPerSubset: [],
                allSubsets: []
            }

            $scope.subsetsToDelete = [];

            $scope.toggleSubsetsToDelete = function (item) {
                if (_.includes($scope.subsetsToDelete, item)) {
                    _.remove($scope.subsetsToDelete, function (i) {
                        return i.name === item.name;
                    });
                } else {
                    $scope.subsetsToDelete.push(item);
                }
            };

                     //OPEN MODAL WITH VIEWS TO BE DELETED
         $scope.openModalSubset = function () {
            var dialog = ngDialog.open({
               className: "ngdialog-theme-default medium",
               template: "__/plugins/subset-all/m-delete-subset.html",
               name: "Subsets",
               scope: $scope,
               controller: ['$rootScope', '$scope', function ($rootScope, $scope) {
                  $scope.subsets = $scope.ngDialogData.subsets;

                  //DELETE ONE SUBSET
                  $scope.deleteSubset = function(index){
                     subset = $scope.subsetsToDelete[index];
                     var subsetFullName = subset.fqn;
                     var semiColumn = subsetFullName.indexOf(":");
                     var dimension = subsetFullName.substr(0, semiColumn);
                     var hierarchyAndSubset = subsetFullName.substr(semiColumn + 1, subsetFullName.length - semiColumn + 1);
                     var semiColumn2 = hierarchyAndSubset.indexOf(":");
                     var hierarchy = hierarchyAndSubset.substr(0, semiColumn2);
                     var subset = hierarchyAndSubset.substr(semiColumn2 + 1, hierarchyAndSubset.length - semiColumn2 + 1);
                     $http.delete(encodeURIComponent($scope.instance) + "/Dimensions('" + dimension + "')/Hierarchies('" + hierarchy + "')/Subsets('" + subset + "')").then(function (result) {
                        if (result.status == 204) {
                           // Add subsets to subsetsDeleted list
                           $scope.subsetsDeleted.push(subsetFullName);
                           //Remove subset from subset to delete list
                           _.remove($scope.subsetsToDelete, function (i) {
                              return i.fqn === subsetFullName;
                           });
                           var message = {class:'success',
                                          icon:'fa-check-square-o',
                                          message: subsetFullName+ " has been deleted"};
                           $scope.messages.push(message);
                        }else{
                           //Can't delete subset
                           $scope.errorMessage = "Delete "+subsetFullName+" failed because "+result.data.error.message;
                           var message = {class:"warning",
                                          icon:'fa-warning',
                                          message:"Delete "+subsetFullName+" failed because "+result.data.error.message};
                           $scope.messages.push(message);
                        }
                     });
                  }
                  //DELETE SUBSETS
                  $scope.deleteSubsets = function () {
                     // Delete subsets
                     //Debugger;
                     $scope.subsetsDeleted = [];
                     $scope.messages = [];
                     for (var s in $scope.subsetsToDelete) {
                        $scope.deleteSubset(s);
                     }
                  }
               }],
               data: {
                  subsets: $scope.subsetsToDelete,
                  subsetsDeleted: $scope.subsetsDeleted,
                  errorMessage: $scope.errorMessage,
               }
            });
         };

            // GET DIMENSION DATA
            $scope.getAllSubsets = function () {
               $scope.lists.allSubsets=[];
                $http.get(encodeURIComponent($scope.instance) + "/ModelDimensions()").then(function (dimensionsData) {
                    $scope.lists.dimensions = dimensionsData.data.value;
                    //LOOP THROUGH DIMENSIONS
                    _.forEach($scope.lists.dimensions, function (value, key) {
                        var dimension = value.Name;
                        $http.get(encodeURIComponent($scope.instance) + "/Dimensions('" + dimension + "')/Hierarchies").then(function (hierarchiesData) {
                            $scope.lists.hierarchies = hierarchiesData.data.value;
                            //LOOP THROUGH HIERARCHIES FOR A DIMENSION
                            _.forEach($scope.lists.hierarchies, function (value, key) {
                                var hierarchy = value.Name;                                                              
                                $http.get(encodeURIComponent($scope.instance) + "/Dimensions('" + dimension + "')/Hierarchies('" + hierarchy + "')/Subsets").then(function (subsetsData) {
                                    $scope.lists.subsets = subsetsData;
                                    //LOOP THROUGH SUBSET FOR A HIERARCHY FOR A DIMENSION
                                    _.forEach($scope.lists.subsets, function (value, key) {
                                        var subsets = value.value;
                                        if (subsets) {
                                            _.forEach(subsets, function (value, key) {
                                                var subset = value.Name;
                                                $scope.lists.allSubsets.push({
                                                    name: subset,
                                                    uniqueName: value.UniqueName,
                                                    expression: value.Expression,
                                                    attributes: value.Attributes,
                                                    fqn: dimension + ':' + hierarchy + ':' + subset,
                                                    hierarchy: hierarchy,
                                                    dimension: dimension
                                                });
                                            });
                                        }
                                    });
                                });
                            });
                        });
                    });
                });
            };
            $scope.getAllSubsets();

            $scope.$on("login-reload", function (event, args) {

            });

            $scope.$on("close-tab", function (event, args) {
                // Event to capture when a user has clicked close on the tab
                if (args.page == "cubewiseSubset" && args.instance == $scope.instance && args.name == null) {
                    // The page matches this one so close it
                    $rootScope.close(args.page, { instance: $scope.instance });
                }
            });

            $scope.$on("$destroy", function (event) {

            });


        }]
    };
});