#### [DiGi\.GLTF\.WebAPI](index.md 'index')

## DiGi\.GLTF\.WebAPI Namespace
### Classes

<a name='DiGi.GLTF.WebAPI.Modify'></a>

## Modify Class

```csharp
public static class Modify
```

Inheritance [System\.Object](https://learn.microsoft.com/en-us/dotnet/api/system.object 'System\.Object') → Modify
### Methods

<a name='DiGi.GLTF.WebAPI.Modify.InitializeAsync(thisMicrosoft.Extensions.DependencyInjection.IServiceCollection)'></a>

## Modify\.InitializeAsync\(this IServiceCollection\) Method

Initializes the GLTF Web API services required by its controllers\.

This method is the extension initialization entry point invoked by the hosting service; the controllers currently require no additional services.

```csharp
public static System.Threading.Tasks.Task InitializeAsync(this Microsoft.Extensions.DependencyInjection.IServiceCollection serviceCollection);
```
#### Parameters

<a name='DiGi.GLTF.WebAPI.Modify.InitializeAsync(thisMicrosoft.Extensions.DependencyInjection.IServiceCollection).serviceCollection'></a>

`serviceCollection` [Microsoft\.Extensions\.DependencyInjection\.IServiceCollection](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.iservicecollection 'Microsoft\.Extensions\.DependencyInjection\.IServiceCollection')

The [Microsoft\.Extensions\.DependencyInjection\.IServiceCollection](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.iservicecollection 'Microsoft\.Extensions\.DependencyInjection\.IServiceCollection') to add services to\.

#### Returns
[System\.Threading\.Tasks\.Task](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task 'System\.Threading\.Tasks\.Task')  
A [System\.Threading\.Tasks\.Task](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task 'System\.Threading\.Tasks\.Task') representing the asynchronous operation\.